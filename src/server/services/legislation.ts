import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant, type Db } from "../db/client";
import {
  amendments, billActions, billCommitteeLinks, billNotes, bills, billSponsors, billStatusHistory, billVersions, committees, follows, legislativeEvents,
  legislativeSessions, legislativeSourceSyncs, legislators, memberships, officeBillLinks, organizations, rollCalls, rollCallVotes, trackedBills, users,
  type BillPosition, type BillPriority, type BillRelationKind, type BillStatus,
} from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, notFound } from "../errors";
import { audit } from "./audit";
import { compareVersions } from "../legislation/diff";
import { isSection, reasonWeight, titleSimilarity, titleTerms, type RelatedReason } from "../legislation/related";
import { sha256 } from "../crypto";
import { providerFor } from "../legislation/sync";
import { logger } from "../logger";

export const BILL_VIEWS = {
  all: "All bills", tracked: "Tracked", sponsored: "Sponsored by this office", hearings: "Hearing soon", moved: "Moved this week", introduced: "New this month",
  voted: "Voted recently", enacted: "Became law", committees: "Your committees", onechamber: "Passed one chamber", dead: "Did not pass",
} as const;
export type BillView = keyof typeof BILL_VIEWS;

export const OPEN_SESSION_VIEWS: BillView[] = ["all", "tracked", "sponsored", "hearings", "moved", "introduced", "voted", "enacted"];
export const CLOSED_SESSION_VIEWS: BillView[] = ["all", "tracked", "sponsored", "committees", "enacted", "onechamber", "dead"];

export const POSITION_LABEL: Record<BillPosition, string> = { support: "Support", oppose: "Oppose", neutral: "Neutral", watching: "Watching" };
export const PRIORITY_LABEL: Record<BillPriority, string> = { high: "High", normal: "Normal", low: "Low" };

export type BillSort = "recent" | "number" | "hearing" | "introduced";
export type BillFilters = {
  view?: BillView; q?: string; session?: string; chamber?: string; status?: string; sponsor?: string; committee?: string; subject?: string; code?: string;
  position?: string; sort?: BillSort; limit?: number; offset?: number;
};

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);
// Subqueries name the outer bill: Drizzle leaves single-table columns bare.
const BILL_ID = sql.raw('"bills"."id"');
const jsonArray = (xs: string[]) => sql`array(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;
const PRIMARY_SPONSOR = sql<string | null>`(select s.name from bill_sponsors s where s.bill_id = ${BILL_ID} and s.sponsor_type = 'primary' order by s.sequence limit 1)`;
const LATEST_COMMITTEE = sql<string | null>`(select c.name from bill_committee_links l join committees c on c.id = l.committee_id where l.bill_id = ${BILL_ID} order by l.referred_at desc nulls last limit 1)`;

export function officeSponsorName(legislatorName: string | null) {
  return legislatorName?.replace(/^(Rep\.|Sen\.|Representative|Senator)\s+/i, "").trim().split(/\s+/).pop() ?? null;
}

export async function officeOf(tx: Db, ctx: OfficeContext) {
  const [org] = await tx.select({
    jurisdiction: organizations.jurisdictionCode, legislatorName: organizations.legislatorName, chamber: organizations.chamber,
    district: organizations.district,
  }).from(organizations).where(eq(organizations.id, ctx.orgId));
  return org;
}

async function sessionStateOf(tx: Db, jurisdiction: string) {
  const [s] = await tx.select({
    id: legislativeSessions.id, identifier: legislativeSessions.identifier, name: legislativeSessions.name, endDate: legislativeSessions.endDate,
  }).from(legislativeSessions).where(eq(legislativeSessions.jurisdictionCode, jurisdiction))
    .orderBy(asc(legislativeSessions.isSpecial), desc(legislativeSessions.startDate)).limit(1);
  return s ? { ...s, closed: Boolean(s.endDate && s.endDate < isoDay(0)) } : null;
}

export async function sessionState(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => sessionStateOf(tx, (await officeOf(tx, ctx)).jurisdiction));
}

export async function officeLegislator(tx: Db, org: { jurisdiction: string; chamber: string; district: string | null }) {
  if (!org.district) return null;
  const [l] = await tx.select().from(legislators)
    .where(and(eq(legislators.jurisdictionCode, org.jurisdiction), eq(legislators.chamber, org.chamber), eq(legislators.district, org.district))).limit(1);
  return l ?? null;
}

const ROLE_ORDER: Record<string, number> = { Chair: 0, "Vice Chair": 1, "Ranking Member": 2, Member: 3 };

function billNumberQuery(q: string) {
  const m = q.trim().match(/^([a-z]{1,4})\.?\s*0*(\d{1,5})$/i);
  return m ? `${m[1].toUpperCase().replace(/\./g, "")} ${Number(m[2])}` : null;
}

export async function listBills(ctx: OfficeContext, f: BillFilters) {
  requirePermission(ctx, "legislation.read");
  const limit = Math.min(f.limit ?? 50, 200);
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const conds: (SQL | undefined)[] = [eq(bills.jurisdictionCode, org.jurisdiction)];
    const q = f.q?.trim();
    if (q) {
      const number = billNumberQuery(q);
      if (number) {
        conds.push(eq(bills.identifier, number));
      } else if (/^\d{1,5}$/.test(q)) {
        conds.push(eq(bills.number, Number(q)));
      } else {
        conds.push(
          sql`(${bills.searchTsv} @@ websearch_to_tsquery('english', ${q}) or exists (select 1 from bill_sponsors s where s.bill_id = ${BILL_ID} and s.name ilike ${`%${q}%`}))`,
        );
      }
    }
    if (f.session) conds.push(eq(bills.sessionId, f.session));
    if (f.chamber === "upper" || f.chamber === "lower") conds.push(eq(bills.chamber, f.chamber));
    if (f.status) conds.push(eq(bills.status, f.status as BillStatus));
    if (f.subject) conds.push(sql`${f.subject} = any(${bills.subjects})`);
    if (f.code) conds.push(sql`${f.code.trim()} = any(${bills.codeSections})`);
    if (f.sponsor) conds.push(sql`exists (select 1 from bill_sponsors s where s.bill_id = ${BILL_ID} and s.name ilike ${`%${f.sponsor}%`})`);
    if (f.committee) conds.push(sql`exists (select 1 from bill_committee_links l where l.bill_id = ${BILL_ID} and l.committee_id = ${f.committee})`);
    if (f.position) {
      conds.push(sql`exists (select 1 from tracked_bills t where t.bill_id = ${BILL_ID} and t.organization_id = ${ctx.orgId} and t.position = ${f.position})`);
    }
    switch (f.view ?? "all") {
      case "tracked":
        conds.push(sql`exists (select 1 from tracked_bills t where t.bill_id = ${BILL_ID} and t.organization_id = ${ctx.orgId})`);
        break;
      case "sponsored": {
        const last = officeSponsorName(org.legislatorName);
        conds.push(last ? sql`exists (select 1 from bill_sponsors s where s.bill_id = ${BILL_ID} and s.name ilike ${`%${last}%`})` : sql`false`);
        break;
      }
      case "moved":
        conds.push(gte(bills.lastActionAt, isoDay(-7)));
        break;
      case "introduced":
        conds.push(gte(bills.introducedAt, isoDay(-30)));
        break;
      case "hearings":
        conds.push(sql`exists (select 1 from legislative_events e where ${BILL_ID} = any(e.bill_ids) and e.starts_at >= now() and e.status = 'scheduled')`);
        break;
      case "voted":
        conds.push(sql`exists (select 1 from roll_calls r where r.bill_id = ${BILL_ID} and r.vote_date >= ${isoDay(-30)})`);
        break;
      case "enacted":
        conds.push(eq(bills.status, "enacted"));
        break;
      case "committees": {
        const seats = (await officeLegislator(tx, org))?.committeeRoles.flatMap((r) => r.code ?? []) ?? [];
        conds.push(
          seats.length
            ? sql`exists (select 1 from bill_committee_links l join committees c on c.id = l.committee_id where l.bill_id = ${BILL_ID} and c.provider_committee_id = any(${jsonArray(seats)}))`
            : sql`false`,
        );
        break;
      }
      case "onechamber":
        conds.push(and(eq(bills.status, "failed"), sql`${bills.statusText} like 'Passed the %'`));
        break;
      case "dead":
        conds.push(eq(bills.status, "failed"));
        break;
    }
    const where = and(...conds);
    const nextEvent = sql`(select min(e.starts_at) from legislative_events e where ${BILL_ID} = any(e.bill_ids) and e.starts_at >= now() and e.status = 'scheduled')`;
    const sort = f.sort ?? (f.view === "hearings" ? "hearing" : "recent");
    const order = sort === "number" ? [asc(bills.billType), asc(bills.number)]
      : sort === "hearing" ? [sql`${nextEvent} asc nulls last`, asc(bills.identifier)]
        : sort === "introduced" ? [sql`${bills.introducedAt} desc nulls last`, asc(bills.identifier)]
          : [sql`${bills.lastActionAt} desc nulls last`, asc(bills.identifier)];
    const rows = await tx
      .select({
        id: bills.id,
        identifier: bills.identifier,
        billType: bills.billType,
        title: bills.title,
        status: bills.status,
        statusText: bills.statusText,
        lastActionAt: bills.lastActionAt,
        lastActionText: bills.lastActionText,
        chamber: bills.chamber,
        subjects: bills.subjects,
        session: legislativeSessions.identifier,
        position: sql<BillPosition | null>`(select t.position from tracked_bills t where t.bill_id = ${BILL_ID} and t.organization_id = ${ctx.orgId})`,
        priority: sql<BillPriority | null>`(select t.priority from tracked_bills t where t.bill_id = ${BILL_ID} and t.organization_id = ${ctx.orgId})`,
        primarySponsor: PRIMARY_SPONSOR,
        primaryParty: sql<string | null>`(select l.party from bill_sponsors s join legislators l on l.id = s.legislator_id where s.bill_id = ${BILL_ID} and s.sponsor_type = 'primary' order by s.sequence limit 1)`,
        committee: LATEST_COMMITTEE,
        nextEvent: sql<string | null>`${nextEvent}::text`,
      })
      .from(bills)
      .innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId))
      .where(where)
      .orderBy(...order)
      .limit(limit + 1)
      .offset(f.offset ?? 0);
    const [{ total }] = await tx.select({ total: count() }).from(bills).where(where);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit, total, jurisdiction: org.jurisdiction };
  });
}

export async function billFilterOptions(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const sessions = await tx.select().from(legislativeSessions).where(eq(legislativeSessions.jurisdictionCode, org.jurisdiction))
      .orderBy(desc(legislativeSessions.startDate));
    const cmte = await tx.select({ id: committees.id, name: committees.name, chamber: committees.chamber }).from(committees)
      .where(eq(committees.jurisdictionCode, org.jurisdiction)).orderBy(committees.name);
    const subjects = await tx.execute<{ subject: string }>(
      sql`select distinct unnest(subjects) as subject from bills where jurisdiction_code = ${org.jurisdiction} order by 1 limit 300`,
    );
    return { sessions, committees: cmte, subjects: subjects.rows.map((r) => r.subject), jurisdiction: org.jurisdiction };
  });
}

export async function legislativeFreshness(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const runs = await tx.select().from(legislativeSourceSyncs).where(eq(legislativeSourceSyncs.jurisdictionCode, org.jurisdiction))
      .orderBy(desc(legislativeSourceSyncs.startedAt)).limit(10);
    const lastOk = runs.find((r) => r.status === "succeeded" || r.status === "partial") ?? null;
    const last = runs[0] ?? null;
    const staleHours = lastOk?.finishedAt ? (Date.now() - lastOk.finishedAt.getTime()) / 3600_000 : null;
    const snapshotAt = providerFor(org.jurisdiction)?.snapshotBuiltAt ?? null;
    return {
      jurisdiction: org.jurisdiction, last, lastOk, snapshotAt, stale: !snapshotAt && (staleHours === null || staleHours > 26), staleHours,
      lastFailed: last && last.status === "failed" ? last : null,
    };
  });
}

export async function getBillDetail(ctx: OfficeContext, billId: string) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [b] = await tx.select({ bill: bills, session: legislativeSessions }).from(bills)
      .innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId)).where(eq(bills.id, billId));
    if (!b) throw notFound("Bill not found.");
    const [sponsors, cmtes, actions, versions, amends, votes, events, history, notes, tracked, followed] = await Promise.all([
      tx.select({
        id: billSponsors.id, name: billSponsors.name, sponsorType: billSponsors.sponsorType, legislatorId: billSponsors.legislatorId,
        contact: legislators.contact, party: legislators.party, district: legislators.district, chamber: legislators.chamber,
      }).from(billSponsors).leftJoin(legislators, eq(legislators.id, billSponsors.legislatorId)).where(eq(billSponsors.billId, billId))
        .orderBy(sql`case when ${billSponsors.sponsorType} = 'primary' then 0 else 1 end`, asc(billSponsors.sequence)),
      tx.select({ id: committees.id, name: committees.name, chamber: committees.chamber, referredAt: billCommitteeLinks.referredAt }).from(billCommitteeLinks)
        .innerJoin(committees, eq(committees.id, billCommitteeLinks.committeeId)).where(eq(billCommitteeLinks.billId, billId))
        .orderBy(asc(billCommitteeLinks.referredAt)),
      tx.select().from(billActions).where(eq(billActions.billId, billId)).orderBy(desc(billActions.actionDate), desc(billActions.sequence)),
      tx.select({
        id: billVersions.id, label: billVersions.label, versionDate: billVersions.versionDate, url: billVersions.url, mimeType: billVersions.mimeType,
        hasText: isNotNull(billVersions.textContent), fetchedAt: billVersions.fetchedAt,
      }).from(billVersions).where(eq(billVersions.billId, billId)).orderBy(asc(billVersions.versionDate), asc(billVersions.createdAt)),
      tx.select().from(amendments).where(eq(amendments.billId, billId)).orderBy(desc(amendments.amendmentDate)),
      tx.select().from(rollCalls).where(eq(rollCalls.billId, billId)).orderBy(sql`${rollCalls.voteDate} desc nulls last`, desc(rollCalls.providerRollCallId)),
      tx.select().from(legislativeEvents).where(sql`${billId} = any(${legislativeEvents.billIds})`).orderBy(asc(legislativeEvents.startsAt)),
      tx.select().from(billStatusHistory).where(eq(billStatusHistory.billId, billId)).orderBy(desc(billStatusHistory.observedAt)),
      tx.select({ id: billNotes.id, body: billNotes.body, createdAt: billNotes.createdAt, author: users.name }).from(billNotes)
        .leftJoin(users, eq(users.id, billNotes.authorId)).where(and(eq(billNotes.billId, billId), eq(billNotes.organizationId, ctx.orgId)))
        .orderBy(desc(billNotes.createdAt)),
      tx.select().from(trackedBills).where(and(eq(trackedBills.billId, billId), eq(trackedBills.organizationId, ctx.orgId))),
      tx.select().from(follows)
        .where(and(eq(follows.organizationId, ctx.orgId), eq(follows.userId, ctx.userId), eq(follows.targetType, "bill"), eq(follows.targetKey, billId))),
    ]);
    const memberVotes = votes.length
      ? await tx.select({
        rollCallId: rollCallVotes.rollCallId, name: rollCallVotes.voterName, vote: rollCallVotes.vote, legislatorId: rollCallVotes.legislatorId,
        party: legislators.party, district: legislators.district,
      }).from(rollCallVotes).leftJoin(legislators, eq(legislators.id, rollCallVotes.legislatorId))
        .where(inArray(rollCallVotes.rollCallId, votes.map((v) => v.id))).orderBy(asc(rollCallVotes.voterName))
      : [];
    const member = await officeLegislator(tx, await officeOf(tx, ctx));
    return {
      ...b, officeMemberId: member?.id ?? null, sponsors, committees: cmtes, actions, versions, amendments: amends,
      votes: votes.map((v) => ({ ...v, members: memberVotes.filter((m) => m.rollCallId === v.id) })), events, history, notes, tracking: tracked[0] ?? null,
      followed: followed.length > 0,
    };
  });
}

export type TrackInput = { position: BillPosition; priority: BillPriority; reason?: string | null; note?: string | null };

export async function trackBills(ctx: OfficeContext, billIds: string[], input: TrackInput) {
  requirePermission(ctx, "legislation.track");
  if (!billIds.length) throw new AppError("validation", "No bill selected.");
  if (!Object.hasOwn(POSITION_LABEL, input.position) || !Object.hasOwn(PRIORITY_LABEL, input.priority)) {
    throw new AppError("validation", "Unknown position or priority.");
  }
  await withTenant(tenantScope(ctx), async (tx) => {
    const found = await tx.select({ id: bills.id, identifier: bills.identifier }).from(bills).where(inArray(bills.id, billIds));
    if (found.length !== new Set(billIds).size) throw notFound("Bill not found.");
    for (const b of found) {
      await tx.insert(trackedBills)
        .values({
          organizationId: ctx.orgId, billId: b.id, trackedBy: ctx.userId, reason: input.reason ?? null, position: input.position, priority: input.priority,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [trackedBills.organizationId, trackedBills.billId],
          set: { position: input.position, priority: input.priority, reason: input.reason ?? null, updatedAt: new Date() },
        });
      if (input.note?.trim()) {
        await tx.insert(billNotes).values({ organizationId: ctx.orgId, billId: b.id, authorId: ctx.userId, body: input.note.trim().slice(0, 5000) });
      }
      await audit(tx, ctx, "bill.tracked", "bill", b.id, { identifier: b.identifier, position: input.position, priority: input.priority });
    }
  });
}

async function billRef(tx: Db, billId: string) {
  const [b] = await tx.select({ id: bills.id, identifier: bills.identifier }).from(bills).where(eq(bills.id, billId));
  if (!b) throw notFound("Bill not found.");
  return b;
}

export async function untrackBill(ctx: OfficeContext, billId: string) {
  requirePermission(ctx, "legislation.track");
  await withTenant(tenantScope(ctx), async (tx) => {
    const b = await billRef(tx, billId);
    await tx.delete(trackedBills).where(and(eq(trackedBills.organizationId, ctx.orgId), eq(trackedBills.billId, billId)));
    await audit(tx, ctx, "bill.untracked", "bill", billId, { identifier: b.identifier });
  });
}

export async function setBillPosition(ctx: OfficeContext, billId: string, position: BillPosition) {
  requirePermission(ctx, "legislation.track");
  if (!Object.hasOwn(POSITION_LABEL, position)) throw new AppError("validation", "Unknown position.");
  await withTenant(tenantScope(ctx), async (tx) => {
    const b = await billRef(tx, billId);
    await tx.insert(trackedBills).values({ organizationId: ctx.orgId, billId, trackedBy: ctx.userId, position, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [trackedBills.organizationId, trackedBills.billId], set: { position, updatedAt: new Date() } });
    await audit(tx, ctx, "bill.position_set", "bill", billId, { identifier: b.identifier, position });
  });
}

export type TrackingPatch = {
  position?: BillPosition; priority?: BillPriority; reason?: string | null; assignedTo?: string | null; nextStep?: string | null; dueDate?: string | null;
};

export async function updateTracking(ctx: OfficeContext, billId: string, patch: TrackingPatch) {
  requirePermission(ctx, "legislation.track");
  if ((patch.position && !Object.hasOwn(POSITION_LABEL, patch.position)) || (patch.priority && !Object.hasOwn(PRIORITY_LABEL, patch.priority))) {
    throw new AppError("validation", "Unknown position or priority.");
  }
  if (patch.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) throw new AppError("validation", "Enter the due date as a full date.");
  if (patch.nextStep && patch.nextStep.length > 300) throw new AppError("validation", "Keep the next step under 300 characters.");
  if (patch.reason && patch.reason.length > 200) throw new AppError("validation", "Keep the reason under 200 characters.");
  // Only these fields come from the caller.
  const set: TrackingPatch = {
    position: patch.position, priority: patch.priority, reason: patch.reason, assignedTo: patch.assignedTo, nextStep: patch.nextStep, dueDate: patch.dueDate,
  };
  await withTenant(tenantScope(ctx), async (tx) => {
    if (patch.assignedTo) {
      const [member] = await tx.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.userId, patch.assignedTo), eq(memberships.status, "active")));
      if (!member) throw new AppError("validation", "That person is not on this office's staff.");
    }
    const updated = await tx.update(trackedBills).set({ ...set, updatedAt: new Date() })
      .where(and(eq(trackedBills.organizationId, ctx.orgId), eq(trackedBills.billId, billId))).returning({ id: trackedBills.id });
    if (!updated.length) throw new AppError("validation", "Track the bill first.");
    await audit(tx, ctx, "bill.tracking_updated", "bill", billId, set);
  });
}

export async function setTracked(ctx: OfficeContext, billId: string, track: boolean, reason?: string) {
  if (track) await trackBills(ctx, [billId], { position: "watching", priority: "normal", reason });
  else await untrackBill(ctx, billId);
}

export async function setFollow(ctx: OfficeContext, targetType: "bill" | "committee" | "topic", targetKey: string, on: boolean) {
  await withTenant(tenantScope(ctx), async (tx) => {
    if (on) {
      await tx.insert(follows).values({ organizationId: ctx.orgId, userId: ctx.userId, targetType, targetKey }).onConflictDoNothing();
    } else {
      await tx.delete(follows)
        .where(and(
          eq(follows.organizationId, ctx.orgId), eq(follows.userId, ctx.userId), eq(follows.targetType, targetType), eq(follows.targetKey, targetKey),
        ));
    }
  });
}

export async function addBillNote(ctx: OfficeContext, billId: string, body: string) {
  requirePermission(ctx, "legislation.track");
  if (!body.trim()) throw new AppError("validation", "Note is empty.");
  await withTenant(tenantScope(ctx), (tx) =>
    tx.insert(billNotes).values({ organizationId: ctx.orgId, billId, authorId: ctx.userId, body: body.trim().slice(0, 5000) }));
}

export type RelatedBill = {
  id: string | null; identifier: string; title: string | null; status: BillStatus | null; chamber: string | null; session: string | null;
  lastActionAt: string | null; lastActionText: string | null; primarySponsor: string | null; position: BillPosition | null; similarity: number;
  reasons: RelatedReason[]; score: number; group: "connected" | "code" | "more";
};

const INVERSE: Partial<Record<BillRelationKind, BillRelationKind>> = {
  replaces: "replaced_by", replaced_by: "replaces", enabling: "enabled_by", enabled_by: "enabling",
};

export async function relatedBills(ctx: OfficeContext, billId: string): Promise<RelatedBill[]> {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [me] = await tx.select({
      id: bills.id, title: bills.title, chamber: bills.chamber, sessionId: bills.sessionId, jurisdiction: bills.jurisdictionCode,
      codeSections: bills.codeSections, subjects: bills.subjects, start: legislativeSessions.startDate,
    }).from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId)).where(eq(bills.id, billId));
    if (!me) throw notFound("Bill not found.");
    const [primary] = await tx.select({ name: billSponsors.name }).from(billSponsors)
      .where(and(eq(billSponsors.billId, billId), eq(billSponsors.sponsorType, "primary"), isNotNull(billSponsors.legislatorId)))
      .orderBy(asc(billSponsors.sequence)).limit(1);

    const source = await tx.execute<{ kind: BillRelationKind; identifier: string; related_id: string | null; dir: "out" | "in" }>(sql`
      select r.kind, r.related_identifier as identifier, rb.id as related_id, 'out' as dir
        from bill_relations r left join bills rb on rb.provider = r.provider and rb.provider_bill_id = r.related_provider_bill_id
        where r.bill_id = ${billId}
      union all
      select r.kind, other.identifier, other.id as related_id, 'in' as dir
        from bills me join bill_relations r on r.provider = me.provider and r.related_provider_bill_id = me.provider_bill_id
        join bills other on other.id = r.bill_id
        where me.id = ${billId}`);
    const links = await tx.select({ billId: officeBillLinks.billId, relatedBillId: officeBillLinks.relatedBillId, note: officeBillLinks.note })
      .from(officeBillLinks)
      .where(and(eq(officeBillLinks.organizationId, ctx.orgId), or(eq(officeBillLinks.billId, billId), eq(officeBillLinks.relatedBillId, billId))));

    const explicit = [
      ...new Set([
        ...source.rows.map((r) => r.related_id).filter((x): x is string => Boolean(x)), ...links.map((l) => (l.billId === billId ? l.relatedBillId : l.billId)),
      ]),
    ];
    const terms = [...titleTerms(me.title)].slice(0, 10);
    const candidates = await tx.execute<{
      id: string; identifier: string; title: string; status: BillStatus; chamber: string; session_id: string; session: string; start_date: string | null;
      code_sections: string[]; subjects: string[]; last_action_at: string | null; last_action_text: string | null; primary_sponsor: string | null;
      position: BillPosition | null;
    }>(sql`
      select b.id, b.identifier, b.title, b.status, b.chamber, b.session_id, s.identifier as session, s.start_date::text as start_date, b.code_sections, b.subjects,
        b.last_action_at::text as last_action_at, b.last_action_text,
        (select sp.name from bill_sponsors sp where sp.bill_id = b.id and sp.sponsor_type = 'primary' order by sp.sequence limit 1) as primary_sponsor,
        (select t.position from tracked_bills t where t.bill_id = b.id and t.organization_id = ${ctx.orgId}) as position
      from bills b join legislative_sessions s on s.id = b.session_id
      where b.jurisdiction_code = ${me.jurisdiction} and b.id <> ${billId} and (
        b.code_sections && ${jsonArray(me.codeSections)}
        or b.subjects && ${jsonArray(me.subjects)}
        or b.id::text = any(${jsonArray(explicit)})
        ${terms.length ? sql`or b.search_tsv @@ to_tsquery('english', ${terms.join(" | ")})` : sql``}
        ${primary ? sql`or exists (select 1 from bill_sponsors sp where sp.bill_id = b.id and sp.sponsor_type = 'primary' and sp.name = ${primary.name})` : sql``}
      )
      limit 400`);

    const byId = new Map<string, RelatedBill>();
    const out: RelatedBill[] = [];
    for (const c of candidates.rows) {
      const similarity = titleSimilarity(me.title, c.title);
      const reasons: RelatedReason[] = [];
      const sharedCodes = c.code_sections.filter((x) => me.codeSections.includes(x));
      const sameSession = c.session_id === me.sessionId;
      const otherChamber = c.chamber !== me.chamber && c.chamber !== "joint" && me.chamber !== "joint";
      const codeBoost = sharedCodes.some(isSection) ? 0.2 : 0;
      if (sameSession && otherChamber && similarity + codeBoost >= 0.5) reasons.push({ kind: "companion" });
      if (!sameSession && similarity + codeBoost >= 0.45) {
        const earlier = (c.start_date ?? "") < (me.start ?? "");
        reasons.push({ kind: earlier ? "earlier_session" : "later_session", session: c.session });
      }
      if (sharedCodes.length) reasons.push({ kind: "code", citations: sharedCodes });
      if (sameSession && primary && c.primary_sponsor === primary.name) reasons.push({ kind: "sponsor", name: primary.name });
      const sharedSubjects = sameSession ? c.subjects.filter((x) => me.subjects.includes(x)) : [];
      if (sharedSubjects.length) reasons.push({ kind: "subject", subjects: sharedSubjects });
      const row: RelatedBill = {
        id: c.id, identifier: c.identifier, title: c.title, status: c.status, chamber: c.chamber, session: c.session, lastActionAt: c.last_action_at,
        lastActionText: c.last_action_text, primarySponsor: c.primary_sponsor, position: c.position, similarity, reasons, score: 0, group: "more",
      };
      byId.set(c.id, row);
      out.push(row);
    }
    for (const r of source.rows) {
      const relation = r.dir === "in" ? (INVERSE[r.kind] ?? r.kind) : r.kind;
      const row = r.related_id ? byId.get(r.related_id) : undefined;
      if (row) {
        row.reasons.unshift({ kind: "source", relation });
      } else if (!r.related_id) {
        out.push({
          id: null, identifier: r.identifier, title: null, status: null, chamber: null, session: null, lastActionAt: null, lastActionText: null,
          primarySponsor: null, position: null, similarity: 0, reasons: [{ kind: "source", relation }], score: 0, group: "connected",
        });
      }
    }
    for (const l of links) {
      const row = byId.get(l.billId === billId ? l.relatedBillId : l.billId);
      if (row) row.reasons.unshift({ kind: "office", note: l.note });
    }
    for (const row of out) {
      row.score = row.reasons.reduce((s, r) => s + reasonWeight(r, row.similarity), 0);
      const kinds = new Set(row.reasons.map((r) => r.kind));
      row.group = ["office", "source", "companion", "earlier_session", "later_session"].some((k) => kinds.has(k as RelatedReason["kind"])) ? "connected"
        : kinds.has("code") ? "code" : "more";
    }
    const more = out.filter((r) => r.group === "more" && r.reasons.length).sort((a, b) => b.score - a.score || b.similarity - a.similarity).slice(0, 8);
    return [...out.filter((r) => r.group !== "more"), ...more].sort((a, b) => b.score - a.score || a.identifier.localeCompare(b.identifier));
  });
}

export async function linkBills(ctx: OfficeContext, billId: string, otherId: string, note?: string) {
  requirePermission(ctx, "legislation.track");
  if (billId === otherId) throw new AppError("validation", "A bill cannot be linked to itself.");
  const [a, b] = [billId, otherId].sort();
  await withTenant(tenantScope(ctx), async (tx) => {
    const found = await tx.select({ id: bills.id, identifier: bills.identifier }).from(bills).where(inArray(bills.id, [a, b]));
    if (found.length !== 2) throw notFound("Bill not found.");
    await tx.insert(officeBillLinks)
      .values({ organizationId: ctx.orgId, billId: a, relatedBillId: b, note: note?.trim().slice(0, 200) || null, createdBy: ctx.userId })
      .onConflictDoUpdate({
        target: [officeBillLinks.organizationId, officeBillLinks.billId, officeBillLinks.relatedBillId], set: { note: note?.trim().slice(0, 200) || null },
      });
    await audit(tx, ctx, "bill.linked", "bill", billId, { with: found.map((f) => f.identifier) });
  });
}

export async function unlinkBills(ctx: OfficeContext, billId: string, otherId: string) {
  requirePermission(ctx, "legislation.track");
  const [a, b] = [billId, otherId].sort();
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.delete(officeBillLinks)
      .where(and(eq(officeBillLinks.organizationId, ctx.orgId), eq(officeBillLinks.billId, a), eq(officeBillLinks.relatedBillId, b)));
    await audit(tx, ctx, "bill.unlinked", "bill", billId, { other: otherId });
  });
}

export async function compareBillVersions(ctx: OfficeContext, billId: string, fromVersionId: string, toVersionId: string) {
  requirePermission(ctx, "legislation.read");
  // Checked first: the text fetch below reads outside the office's scope.
  await withTenant(tenantScope(ctx), (tx) =>
    tx.select({ id: billVersions.id }).from(billVersions).where(inArray(billVersions.id, [fromVersionId, toVersionId])));
  await ensureVersionTexts([fromVersionId, toVersionId]);
  return withTenant(tenantScope(ctx), async (tx) => {
    const vs = await tx.select().from(billVersions).where(and(eq(billVersions.billId, billId), inArray(billVersions.id, [fromVersionId, toVersionId])));
    const from = vs.find((v) => v.id === fromVersionId);
    const to = vs.find((v) => v.id === toVersionId);
    if (!from || !to) throw notFound("Version not found.");
    if (!from.textContent || !to.textContent) {
      return { from, to, comparison: null, missing: [!from.textContent ? from.label : null, !to.textContent ? to.label : null].filter(Boolean) as string[] };
    }
    return {
      from: { ...from, textContent: undefined }, to: { ...to, textContent: undefined }, comparison: compareVersions(from.textContent, to.textContent),
      missing: [] as string[],
    };
  });
}

export async function compareBills(ctx: OfficeContext, a: { billId: string; versionId?: string }, b: { billId: string; versionId?: string }) {
  requirePermission(ctx, "legislation.read");
  const load = (billId: string) => withTenant(tenantScope(ctx), async (tx) => {
    const [bill] = await tx.select({
      id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, session: legislativeSessions.identifier,
    }).from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId)).where(eq(bills.id, billId));
    if (!bill) throw notFound("Bill not found.");
    const versions = await tx.select({ id: billVersions.id, label: billVersions.label, versionDate: billVersions.versionDate }).from(billVersions)
      .where(eq(billVersions.billId, billId)).orderBy(asc(billVersions.versionDate), asc(billVersions.createdAt));
    return { bill, versions };
  });
  const [left, right] = await Promise.all([load(a.billId), load(b.billId)]);
  const pick = (side: typeof left, versionId?: string) => side.versions.find((v) => v.id === versionId) ?? side.versions[side.versions.length - 1] ?? null;
  const lv = pick(left, a.versionId);
  const rv = pick(right, b.versionId);
  if (!lv || !rv) {
    return {
      left: { ...left, version: lv }, right: { ...right, version: rv }, comparison: null,
      missing: [!lv ? `${left.bill.identifier} has no versions on record` : null, !rv ? `${right.bill.identifier} has no versions on record` : null].filter(
        Boolean,
      ) as string[],
    };
  }
  await ensureVersionTexts([lv.id, rv.id]);
  const texts = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({ id: billVersions.id, text: billVersions.textContent }).from(billVersions).where(inArray(billVersions.id, [lv.id, rv.id])));
  const lt = texts.find((t) => t.id === lv.id)?.text;
  const rt = texts.find((t) => t.id === rv.id)?.text;
  const missing = [!lt ? `${left.bill.identifier} (${lv.label})` : null, !rt ? `${right.bill.identifier} (${rv.label})` : null].filter(Boolean) as string[];
  return { left: { ...left, version: lv }, right: { ...right, version: rv }, comparison: lt && rt ? compareVersions(lt, rt) : null, missing };
}

async function ensureVersionTexts(versionIds: string[]) {
  const db = await systemDb();
  const rows = await db.select({
    id: billVersions.id, billId: billVersions.billId, providerVersionId: billVersions.providerVersionId, url: billVersions.url, mimeType: billVersions.mimeType,
    hasText: isNotNull(billVersions.textContent), jurisdiction: bills.jurisdictionCode, provider: bills.provider,
  }).from(billVersions).innerJoin(bills, eq(bills.id, billVersions.billId)).where(inArray(billVersions.id, versionIds));
  for (const v of rows.filter((r) => !r.hasText)) {
    const provider = providerFor(v.jurisdiction, v.provider);
    if (!provider || provider.key !== v.provider) continue;
    try {
      const text = await provider.getVersionText(v.jurisdiction, v);
      if (text) await db.update(billVersions).set({ textContent: text, textSha256: sha256(text), fetchedAt: new Date() }).where(eq(billVersions.id, v.id));
    } catch (e) {
      logger.warn("legislation.text_on_demand_failed", { version: v.providerVersionId, error: (e as Error).message.slice(0, 120) });
    }
  }
}

export async function searchBillsByText(ctx: OfficeContext, q: string, limit = 8) {
  requirePermission(ctx, "legislation.read");
  const number = billNumberQuery(q);
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    return tx.select({ id: bills.id, identifier: bills.identifier, title: bills.title, session: legislativeSessions.identifier, status: bills.status })
      .from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId))
      .where(and(
        eq(bills.jurisdictionCode, org.jurisdiction), number ? eq(bills.identifier, number) : sql`${bills.searchTsv} @@ websearch_to_tsquery('english', ${q})`,
      ))
      .orderBy(desc(sql`ts_rank(${bills.searchTsv}, websearch_to_tsquery('english', ${q}))`), desc(legislativeSessions.startDate)).limit(limit);
  });
}

export async function listEvents(ctx: OfficeContext, opts: { from: Date; to: Date; trackedOnly?: boolean }) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const events = await tx.select({
      id: legislativeEvents.id, kind: legislativeEvents.kind, title: legislativeEvents.title, startsAt: legislativeEvents.startsAt,
      location: legislativeEvents.location, status: legislativeEvents.status, billIds: legislativeEvents.billIds, sourceUrl: legislativeEvents.sourceUrl,
      committeeId: legislativeEvents.committeeId, committee: committees.name,
    }).from(legislativeEvents).leftJoin(committees, eq(committees.id, legislativeEvents.committeeId))
      .where(and(
        eq(legislativeEvents.jurisdictionCode, org.jurisdiction), gte(legislativeEvents.startsAt, opts.from), lte(legislativeEvents.startsAt, opts.to),
      ))
      .orderBy(asc(legislativeEvents.startsAt));
    const ids = [...new Set(events.flatMap((e) => e.billIds))];
    const billRows = ids.length
      ? await tx.select({
        id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, position: trackedBills.position, priority: trackedBills.priority,
      }).from(bills).leftJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId))).where(inArray(bills.id, ids))
      : [];
    const withBills = events.map((e) => ({ ...e, bills: billRows.filter((b) => e.billIds.includes(b.id)) }));
    return opts.trackedOnly ? withBills.filter((e) => e.bills.some((b) => b.position)) : withBills;
  });
}

export async function latestEventDate(ctx: OfficeContext, opts: { trackedOnly?: boolean }) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const rows = await tx.execute<{ latest: string | null }>(sql`
      select max(e.starts_at)::text as latest from legislative_events e
       where e.jurisdiction_code = ${org.jurisdiction}
         ${opts.trackedOnly ? sql`and exists (select 1 from tracked_bills t where t.organization_id = ${ctx.orgId} and t.bill_id = any(e.bill_ids))` : sql``}`);
    return rows.rows[0]?.latest ? new Date(rows.rows[0].latest) : null;
  });
}

export async function listCommittees(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const rows = await tx.execute<{
      id: string; name: string; chamber: string | null; provider_committee_id: string; bills: number; active: number; enacted: number; tracked: number;
      next_hearing: string | null;
    }>(sql`
      select c.id, c.name, c.chamber, c.provider_committee_id,
        (select count(*)::int from bill_committee_links l join bills b on b.id = l.bill_id where l.committee_id = c.id and b.status = 'enacted') as enacted,
        (select count(*)::int from bill_committee_links l where l.committee_id = c.id) as bills,
        (select count(*)::int from bill_committee_links l join bills b on b.id = l.bill_id where l.committee_id = c.id and b.status in ('introduced', 'in_committee')) as active,
        (select count(*)::int from bill_committee_links l join tracked_bills t on t.bill_id = l.bill_id and t.organization_id = ${ctx.orgId} where l.committee_id = c.id) as tracked,
        (select min(e.starts_at)::text from legislative_events e where e.starts_at >= now() and e.status = 'scheduled'
           and (e.committee_id = c.id or exists (select 1 from bill_committee_links l where l.committee_id = c.id and l.bill_id = any(e.bill_ids)) and e.title ilike '%' || c.name || '%')) as next_hearing
      from committees c where c.jurisdiction_code = ${org.jurisdiction}
      order by c.chamber nulls last, c.name`);
    const seats = (await officeLegislator(tx, org))?.committeeRoles ?? [];
    const session = await sessionStateOf(tx, org.jurisdiction);
    return {
      rows: rows.rows.map((c) => ({ ...c, role: seats.find((s) => s.code === c.provider_committee_id)?.role ?? null })), closed: session?.closed ?? false,
    };
  });
}

export async function getCommittee(ctx: OfficeContext, committeeId: string) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [c] = await tx.select().from(committees).where(eq(committees.id, committeeId));
    if (!c) throw notFound("Committee not found.");
    const billRows = await tx.select({
      id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, statusText: bills.statusText, lastActionAt: bills.lastActionAt,
      lastActionText: bills.lastActionText, referredAt: billCommitteeLinks.referredAt, position: trackedBills.position, primarySponsor: PRIMARY_SPONSOR,
    }).from(billCommitteeLinks).innerJoin(bills, eq(bills.id, billCommitteeLinks.billId))
      .leftJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId)))
      .where(eq(billCommitteeLinks.committeeId, committeeId)).orderBy(sql`${bills.lastActionAt} desc nulls last`);
    const ids = billRows.map((b) => b.id);
    const session = await sessionStateOf(tx, c.jurisdictionCode);
    const closed = session?.closed ?? false;
    const roster = await tx.select({
      id: legislators.id, name: legislators.name, party: legislators.party, chamber: legislators.chamber, district: legislators.district,
      committeeRoles: legislators.committeeRoles, contact: legislators.contact,
    }).from(legislators)
      .where(and(
        eq(legislators.jurisdictionCode, c.jurisdictionCode), sql`${legislators.committeeRoles} @> ${JSON.stringify([{ code: c.providerCommitteeId }])}::jsonb`,
      ));
    const members = roster.map(({ committeeRoles, ...m }) => ({ ...m, role: committeeRoles.find((r) => r.code === c.providerCommitteeId)?.role ?? "Member" }))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.chamber ?? "").localeCompare(b.chamber ?? "") || a.name.localeCompare(b.name));
    const events = ids.length
      ? await tx.select().from(legislativeEvents)
        .where(and(
          closed ? undefined : gte(legislativeEvents.startsAt, new Date(Date.now() - 86400_000)),
          or(eq(legislativeEvents.committeeId, committeeId), sql`${legislativeEvents.billIds} && ${jsonArray(ids)}::uuid[]`),
        ))
        .orderBy(closed ? desc(legislativeEvents.startsAt) : asc(legislativeEvents.startsAt)).limit(closed ? 200 : 20)
      : [];
    return {
      committee: c, bills: billRows, members, closed,
      events: events.filter((e) => e.committeeId === committeeId || e.title.toLowerCase().includes(c.name.toLowerCase())),
    };
  });
}

export async function listLegislators(ctx: OfficeContext, f: { chamber?: string; party?: string; q?: string }) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const conds: (SQL | undefined)[] = [eq(legislators.jurisdictionCode, org.jurisdiction), eq(legislators.active, true)];
    if (f.chamber === "upper" || f.chamber === "lower") conds.push(eq(legislators.chamber, f.chamber));
    if (f.party) conds.push(eq(legislators.party, f.party));
    if (f.q?.trim()) conds.push(or(sql`${legislators.name} ilike ${`%${f.q.trim()}%`}`, eq(legislators.district, f.q.trim())));
    return tx
      .select({
        id: legislators.id,
        name: legislators.name,
        party: legislators.party,
        chamber: legislators.chamber,
        district: legislators.district,
        authored: sql<number>`(select count(*)::int from bill_sponsors s where s.legislator_id = legislators.id and s.sponsor_type = 'primary')`,
        cosponsored: sql<number>`(select count(*)::int from bill_sponsors s where s.legislator_id = legislators.id and s.sponsor_type = 'cosponsor')`,
        enacted: sql<number>`(select count(*)::int from bill_sponsors s join bills b on b.id = s.bill_id where s.legislator_id = legislators.id and s.sponsor_type = 'primary' and b.status = 'enacted')`,
      })
      .from(legislators)
      .where(and(...conds))
      .orderBy(sql`(select count(*) from bill_sponsors s where s.legislator_id = legislators.id and s.sponsor_type = 'primary') desc`, asc(legislators.name))
      .limit(400);
  });
}

export async function getLegislator(ctx: OfficeContext, legislatorId: string) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [l] = await tx.select().from(legislators).where(eq(legislators.id, legislatorId));
    if (!l) throw notFound("Legislator not found.");
    const sponsored = await tx.select({
      id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, statusText: bills.statusText, lastActionAt: bills.lastActionAt,
      lastActionText: bills.lastActionText, sponsorType: billSponsors.sponsorType, session: legislativeSessions.identifier, position: trackedBills.position,
    }).from(billSponsors).innerJoin(bills, eq(bills.id, billSponsors.billId)).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId))
      .leftJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId)))
      .where(eq(billSponsors.legislatorId, legislatorId))
      .orderBy(sql`case when ${billSponsors.sponsorType} = 'primary' then 0 else 1 end`, sql`${bills.lastActionAt} desc nulls last`);
    const votes = await tx.select({
      vote: rollCallVotes.vote, motion: rollCalls.motion, voteDate: rollCalls.voteDate, passed: rollCalls.passed, yes: rollCalls.yes, no: rollCalls.no,
      billId: bills.id, identifier: bills.identifier, title: bills.title, position: trackedBills.position,
    }).from(rollCallVotes).innerJoin(rollCalls, eq(rollCalls.id, rollCallVotes.rollCallId)).innerJoin(bills, eq(bills.id, rollCalls.billId))
      .leftJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId)))
      .where(eq(rollCallVotes.legislatorId, legislatorId)).orderBy(sql`${rollCalls.voteDate} desc nulls last`, desc(rollCalls.providerRollCallId));
    return { legislator: l, sponsored, votes };
  });
}

export async function todayBriefing(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const week = isoDay(-7);
    const moved = await tx.select({
      billId: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, position: trackedBills.position,
      priority: trackedBills.priority, actionDate: billActions.actionDate, description: billActions.description, chamber: billActions.chamber,
    }).from(billActions).innerJoin(bills, eq(bills.id, billActions.billId))
      .innerJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId))).where(gte(billActions.actionDate, week))
      .orderBy(sql`case ${trackedBills.priority} when 'high' then 0 when 'normal' then 1 else 2 end`, desc(billActions.actionDate), desc(billActions.sequence))
      .limit(30);
    const counts = await tx.execute<{ position: BillPosition; n: number }>(
      sql`select position, count(*)::int as n from tracked_bills where organization_id = ${ctx.orgId} group by 1`,
    );
    const last = officeSponsorName(org.legislatorName);
    const own = last
      ? await tx.select({
        id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, lastActionAt: bills.lastActionAt,
        lastActionText: bills.lastActionText, billType: bills.billType, chamber: bills.chamber,
      }).from(bills)
        .where(and(
          eq(bills.jurisdictionCode, org.jurisdiction),
          sql`exists (select 1 from bill_sponsors s where s.bill_id = ${BILL_ID} and s.sponsor_type = 'primary' and s.name ilike ${`%${last}%`})`,
        ))
        .orderBy(sql`${bills.lastActionAt} desc nulls last`).limit(12)
      : [];
    const session = await sessionStateOf(tx, org.jurisdiction);
    const results = session?.closed
      ? await tx.select({
        id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, statusText: bills.statusText, statusDate: bills.statusDate,
        billType: bills.billType, position: trackedBills.position,
      }).from(trackedBills).innerJoin(bills, eq(bills.id, trackedBills.billId)).where(eq(trackedBills.organizationId, ctx.orgId))
        .orderBy(sql`${bills.statusDate} desc nulls last`, asc(bills.number))
      : [];
    const followUps = await tx.select({
      id: bills.id, identifier: bills.identifier, title: bills.title, nextStep: trackedBills.nextStep, dueDate: trackedBills.dueDate,
      assignedTo: trackedBills.assignedTo, assignee: sql<string | null>`(select u.name from users u where u.id = ${trackedBills.assignedTo})`,
    }).from(trackedBills).innerJoin(bills, eq(bills.id, trackedBills.billId))
      .where(and(eq(trackedBills.organizationId, ctx.orgId), or(isNotNull(trackedBills.nextStep), isNotNull(trackedBills.dueDate))))
      .orderBy(sql`${trackedBills.dueDate} asc nulls last`, asc(bills.number)).limit(20);
    const legislator = session?.closed ? await officeLegislator(tx, org) : null;
    const seatCodes = legislator?.committeeRoles.flatMap((r) => r.code ?? []) ?? [];
    const seatRows = seatCodes.length ? await tx.execute<{ id: string; name: string; code: string; bills: number; enacted: number }>(sql`
          select c.id, c.name, c.provider_committee_id as code,
            (select count(*)::int from bill_committee_links l where l.committee_id = c.id) as bills,
            (select count(*)::int from bill_committee_links l join bills b on b.id = l.bill_id where l.committee_id = c.id and b.status = 'enacted') as enacted
          from committees c where c.jurisdiction_code = ${org.jurisdiction} and c.provider_committee_id = any(${jsonArray(seatCodes)})`) : { rows: [] };
    const seats = (legislator?.committeeRoles ?? []).flatMap((r) => seatRows.rows.filter((c) => c.code === r.code).map((c) => ({ ...c, role: r.role })))
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
    const votes = await tx.select({
      id: rollCalls.id, billId: bills.id, identifier: bills.identifier, title: bills.title, motion: rollCalls.motion, voteDate: rollCalls.voteDate,
      yes: rollCalls.yes, no: rollCalls.no, passed: rollCalls.passed, chamber: rollCalls.chamber, position: trackedBills.position,
    }).from(rollCalls).innerJoin(bills, eq(bills.id, rollCalls.billId))
      .innerJoin(trackedBills, and(eq(trackedBills.billId, bills.id), eq(trackedBills.organizationId, ctx.orgId))).where(gte(rollCalls.voteDate, isoDay(-30)))
      .orderBy(sql`${rollCalls.voteDate} desc nulls last`).limit(10);
    return {
      moved, positions: Object.fromEntries(counts.rows.map((r) => [r.position, r.n])) as Partial<Record<BillPosition, number>>, own, votes, sponsorName: last,
      jurisdiction: org.jurisdiction, session, results, seats, followUps,
    };
  });
}

export async function trackedReport(ctx: OfficeContext, f: { position?: string; priority?: string; assignedTo?: string } = {}) {
  requirePermission(ctx, "reports.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const conds: (SQL | undefined)[] = [eq(trackedBills.organizationId, ctx.orgId)];
    if (f.position) conds.push(eq(trackedBills.position, f.position as BillPosition));
    if (f.priority) conds.push(eq(trackedBills.priority, f.priority as BillPriority));
    if (f.assignedTo) conds.push(eq(trackedBills.assignedTo, f.assignedTo));
    return tx
      .select({
        id: bills.id,
        identifier: bills.identifier,
        title: bills.title,
        status: bills.status,
        statusText: bills.statusText,
        statusDate: bills.statusDate,
        lastActionAt: bills.lastActionAt,
        lastActionText: bills.lastActionText,
        session: legislativeSessions.identifier,
        position: trackedBills.position,
        priority: trackedBills.priority,
        reason: trackedBills.reason,
        nextStep: trackedBills.nextStep,
        dueDate: trackedBills.dueDate,
        assignee: sql<string | null>`(select u.name from users u where u.id = ${trackedBills.assignedTo})`,
        trackedAt: trackedBills.createdAt,
        primarySponsor: PRIMARY_SPONSOR,
        committee: LATEST_COMMITTEE,
        nextEvent: sql<string | null>`(select min(e.starts_at)::text from legislative_events e where ${BILL_ID} = any(e.bill_ids) and e.starts_at >= now() and e.status = 'scheduled')`,
        latestNote: sql<string | null>`(select n.body from bill_notes n where n.bill_id = ${BILL_ID} and n.organization_id = ${ctx.orgId} order by n.created_at desc limit 1)`,
      })
      .from(trackedBills)
      .innerJoin(bills, eq(bills.id, trackedBills.billId))
      .innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId))
      .where(and(...conds))
      .orderBy(sql`case ${trackedBills.priority} when 'high' then 0 when 'normal' then 1 else 2 end`, asc(bills.billType), asc(bills.number));
  });
}
