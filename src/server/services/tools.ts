import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "../db/client";
import {
  billAlertRules, bills, billSponsors, committees, legislativeEvents, legislativeSessions, legislators, notifications, rollCalls, rollCallVotes, trackedBills,
  users, whipEntries, type BillAlertKind, type BillPosition, type MemberContact,
} from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, notFound } from "../errors";
import { audit } from "./audit";
import { getBillDetail, listBills, officeLegislator, officeOf, officeSponsorName, type BillFilters } from "./legislation";
import { isPassageVote, MIN_VOTES_FOR_SCORE, voteOutcome } from "../legislation/scoring";
import { WHIP_STANCES, type WhipStance } from "@/lib/whip";
import { shortDate } from "@/lib/format";

const CHAMBER_NAME: Record<string, string> = { upper: "Senate", lower: "House" };

export type WhipRow = {
  id: string; name: string; party: string | null; district: string | null; contact: MemberContact; stance: WhipStance; basis: string | null;
  note: string | null; officeSet: boolean; autoStance: WhipStance; autoBasis: string | null;
};

function floorChamber(b: { chamber: string; status: string }) {
  const origin = b.chamber === "upper" ? "upper" : "lower";
  return b.status === "passed_chamber" ? (origin === "upper" ? "lower" : "upper") : origin;
}

export async function whipBoard(ctx: OfficeContext, billId: string, opts: { chamber?: string } = {}) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [b] = await tx.select({
      id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, chamber: bills.chamber, jurisdiction: bills.jurisdictionCode,
      session: legislativeSessions.name,
    }).from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId)).where(eq(bills.id, billId));
    if (!b) throw notFound("Bill not found.");
    const chamber = opts.chamber === "upper" || opts.chamber === "lower" ? opts.chamber : floorChamber(b);
    const members = await tx.select({
      id: legislators.id, name: legislators.name, party: legislators.party, district: legislators.district, contact: legislators.contact,
    }).from(legislators).where(and(eq(legislators.jurisdictionCode, b.jurisdiction), eq(legislators.chamber, chamber), eq(legislators.active, true)))
      .orderBy(asc(legislators.name));
    const sponsors = await tx.select({ legislatorId: billSponsors.legislatorId, sponsorType: billSponsors.sponsorType }).from(billSponsors)
      .where(and(eq(billSponsors.billId, billId), isNotNull(billSponsors.legislatorId)));
    const votes = await tx.select({
      legislatorId: rollCallVotes.legislatorId, vote: rollCallVotes.vote, motion: rollCalls.motion, voteDate: rollCalls.voteDate,
    }).from(rollCallVotes).innerJoin(rollCalls, eq(rollCalls.id, rollCallVotes.rollCallId))
      .where(and(eq(rollCalls.billId, billId), eq(rollCalls.chamber, chamber), isNotNull(rollCallVotes.legislatorId)))
      .orderBy(sql`${rollCalls.voteDate} asc nulls first`, rollCalls.providerRollCallId);
    const entries = await tx.select().from(whipEntries).where(and(eq(whipEntries.organizationId, ctx.orgId), eq(whipEntries.billId, billId)));

    const lastVote = new Map<string, (typeof votes)[number]>();
    for (const v of votes) if (isPassageVote(v.motion) && (v.vote === "yes" || v.vote === "no")) lastVote.set(v.legislatorId!, v);
    const sponsorOf = new Map(sponsors.map((s) => [s.legislatorId!, s.sponsorType]));
    const entryOf = new Map(entries.map((e) => [e.legislatorId, e]));

    const rows: WhipRow[] = members.map((m) => {
      const recorded = lastVote.get(m.id);
      const sponsor = sponsorOf.get(m.id);
      const autoStance: WhipStance = recorded ? (recorded.vote === "yes" ? "yes" : "no") : sponsor ? "yes" : "undecided";
      const autoBasis = recorded ? `Voted ${recorded.vote}, ${recorded.motion}${recorded.voteDate ? `, ${shortDate(recorded.voteDate)}` : ""}`
        : sponsor ? (sponsor === "primary" ? "Lead sponsor" : "Co-sponsor") : null;
      const entry = entryOf.get(m.id);
      return {
        ...m, stance: entry?.stance ?? autoStance, basis: entry ? "Set by your office" : autoBasis, note: entry?.note ?? null, officeSet: Boolean(entry),
        autoStance, autoBasis,
      };
    });
    const office = await officeLegislator(tx, await officeOf(tx, ctx));
    return { bill: b, chamber, chamberName: CHAMBER_NAME[chamber], rows, seats: rows.length, officeMemberId: office?.id ?? null };
  });
}

export async function setWhipStance(ctx: OfficeContext, billId: string, legislatorId: string, stance: WhipStance | null, note?: string | null) {
  requirePermission(ctx, "legislation.track");
  if (stance && !WHIP_STANCES.includes(stance)) throw new AppError("validation", "Unknown stance.");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [b] = await tx.select({ identifier: bills.identifier, jurisdiction: bills.jurisdictionCode }).from(bills).where(eq(bills.id, billId));
    if (!b) throw notFound("Bill not found.");
    const [m] = await tx.select({ name: legislators.name }).from(legislators)
      .where(and(eq(legislators.id, legislatorId), eq(legislators.jurisdictionCode, b.jurisdiction)));
    if (!m) throw notFound("Member not found.");
    if (!stance) {
      await tx.delete(whipEntries)
        .where(and(eq(whipEntries.organizationId, ctx.orgId), eq(whipEntries.billId, billId), eq(whipEntries.legislatorId, legislatorId)));
    } else {
      const cleaned = note?.trim().slice(0, 300) || null;
      await tx.insert(whipEntries)
        .values({ organizationId: ctx.orgId, billId, legislatorId, stance, note: cleaned, updatedBy: ctx.userId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [whipEntries.organizationId, whipEntries.billId, whipEntries.legislatorId],
          set: { stance, note: cleaned, updatedBy: ctx.userId, updatedAt: new Date() },
        });
    }
    await audit(tx, ctx, "whip.updated", "bill", billId, { identifier: b.identifier, member: m.name, stance });
  });
}

export type ScorecardRow = {
  id: string; name: string; party: string | null; chamber: string | null; district: string | null; with: number; against: number; missed: number;
  counted: number; score: number | null; partners: number; backed: number; opposed: number;
};

export async function scorecards(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const taken = await tx.select({ billId: trackedBills.billId, position: trackedBills.position }).from(trackedBills)
      .where(and(eq(trackedBills.organizationId, ctx.orgId), inArray(trackedBills.position, ["support", "oppose"])));
    const positionOf = new Map<string, BillPosition>(taken.map((t) => [t.billId, t.position]));
    const billIds = [...positionOf.keys()];
    const votes = billIds.length
      ? await tx.select({
        legislatorId: rollCallVotes.legislatorId, vote: rollCallVotes.vote, rollCallId: rollCalls.id, billId: rollCalls.billId, motion: rollCalls.motion,
      }).from(rollCallVotes).innerJoin(rollCalls, eq(rollCalls.id, rollCallVotes.rollCallId))
        .where(and(inArray(rollCalls.billId, billIds), isNotNull(rollCallVotes.legislatorId)))
      : [];
    const counted = votes.filter((v) => isPassageVote(v.motion));
    const sponsors = await tx.select({ legislatorId: billSponsors.legislatorId, name: billSponsors.name, billId: billSponsors.billId }).from(billSponsors)
      .innerJoin(bills, eq(bills.id, billSponsors.billId)).where(eq(bills.jurisdictionCode, org.jurisdiction));
    const last = officeSponsorName(org.legislatorName)?.toLowerCase();
    const isOffice = (name: string) => Boolean(last) && name.toLowerCase().includes(last!);
    const officeBills = new Set(sponsors.filter((s) => isOffice(s.name)).map((s) => s.billId));

    const members = await tx.select({
      id: legislators.id, name: legislators.name, party: legislators.party, chamber: legislators.chamber, district: legislators.district,
    }).from(legislators).where(and(eq(legislators.jurisdictionCode, org.jurisdiction), eq(legislators.active, true)));

    const byMember = new Map<string, ScorecardRow>(members.map((m) => [
      m.id, { ...m, with: 0, against: 0, missed: 0, counted: 0, score: null, partners: 0, backed: 0, opposed: 0 },
    ]));
    for (const v of counted) {
      const row = byMember.get(v.legislatorId!);
      const outcome = voteOutcome(positionOf.get(v.billId), v.vote);
      if (row && outcome) row[outcome]++;
    }
    for (const s of sponsors) {
      const row = s.legislatorId ? byMember.get(s.legislatorId) : undefined;
      if (!row) continue;
      if (officeBills.has(s.billId) && !isOffice(s.name)) row.partners++;
      const position = positionOf.get(s.billId);
      if (position === "support") row.backed++;
      if (position === "oppose") row.opposed++;
    }
    const rows = [...byMember.values()].map((r) => {
      const yesOrNo = r.with + r.against;
      return { ...r, counted: yesOrNo, score: yesOrNo >= MIN_VOTES_FOR_SCORE ? Math.round((r.with / yesOrNo) * 100) : null };
    }).filter((r) => r.counted + r.missed + r.partners + r.backed + r.opposed > 0 && !isOffice(r.name));
    return { rows, rollCalls: new Set(counted.map((v) => v.rollCallId)).size, bills: new Set(counted.map((v) => v.billId)).size };
  });
}

const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

export async function hearingPrep(ctx: OfficeContext, eventId: string) {
  requirePermission(ctx, "legislation.read");
  const event = await withTenant(tenantScope(ctx), async (tx) => {
    const org = await officeOf(tx, ctx);
    const [e] = await tx.select({
      id: legislativeEvents.id, title: legislativeEvents.title, startsAt: legislativeEvents.startsAt, location: legislativeEvents.location,
      status: legislativeEvents.status, billIds: legislativeEvents.billIds, committee: committees.name, committeeId: committees.id,
    }).from(legislativeEvents).leftJoin(committees, eq(committees.id, legislativeEvents.committeeId))
      .where(and(eq(legislativeEvents.id, eventId), eq(legislativeEvents.jurisdictionCode, org.jurisdiction)));
    if (!e) throw notFound("Meeting not found.");
    return e;
  });
  const items: Awaited<ReturnType<typeof getBillDetail>>[] = [];
  for (const id of event.billIds) items.push(await getBillDetail(ctx, id));
  const rank = (d: (typeof items)[number]) => (d.tracking ? PRIORITY_RANK[d.tracking.priority] : 3);
  items.sort((a, b) => rank(a) - rank(b) || a.bill.identifier.localeCompare(b.bill.identifier));
  return { event, items };
}

export const ALERT_KIND_LABEL: Record<BillAlertKind, string> = { keyword: "Keyword", code: "Code section", subject: "Subject", sponsor: "Sponsor" };

const alertFilter = (kind: BillAlertKind, value: string): BillFilters =>
  (kind === "keyword" ? { q: value } : kind === "code" ? { code: value } : kind === "subject" ? { subject: value } : { sponsor: value });

export function alertSearchHref(kind: BillAlertKind, value: string) {
  return `/bills?${kind === "keyword" ? "q" : kind}=${encodeURIComponent(value)}`;
}

function cleanAlertValue(kind: BillAlertKind, raw: string) {
  const value = raw.trim().replace(/\s+/g, " ");
  if (kind !== "code") return value;
  const code = value.replace(/^[^\d]+/, "");
  if (!/^\d+[a-z]?(-\d+[a-z]?(\.\d+)?)*$/i.test(code)) throw new AppError("validation", "Enter a code section as digits and dashes, such as 20-2 or 20-2-161.");
  return code;
}

export async function addAlertRule(ctx: OfficeContext, kind: BillAlertKind, raw: string) {
  requirePermission(ctx, "legislation.track");
  if (!Object.hasOwn(ALERT_KIND_LABEL, kind)) throw new AppError("validation", "Unknown alert type.");
  const value = cleanAlertValue(kind, raw);
  if (value.length < 2 || value.length > 120) throw new AppError("validation", "Enter between 2 and 120 characters.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.insert(billAlertRules).values({ organizationId: ctx.orgId, kind, value, createdBy: ctx.userId }).onConflictDoNothing();
    await audit(tx, ctx, "alert_rule.created", "alert_rule", value, { kind, value });
  });
}

export async function setAlertRuleActive(ctx: OfficeContext, id: string, active: boolean) {
  requirePermission(ctx, "legislation.track");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(billAlertRules).set({ active }).where(and(eq(billAlertRules.id, id), eq(billAlertRules.organizationId, ctx.orgId)));
    await audit(tx, ctx, active ? "alert_rule.resumed" : "alert_rule.paused", "alert_rule", id, {});
  });
}

export async function deleteAlertRule(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "legislation.track");
  await withTenant(tenantScope(ctx), async (tx) => {
    const removed = await tx.delete(billAlertRules).where(and(eq(billAlertRules.id, id), eq(billAlertRules.organizationId, ctx.orgId)))
      .returning({ value: billAlertRules.value });
    if (!removed.length) throw notFound("Alert not found.");
    await audit(tx, ctx, "alert_rule.deleted", "alert_rule", id, { value: removed[0].value });
  });
}

export async function listAlertRules(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  const { rules, hits } = await withTenant(tenantScope(ctx), async (tx) => {
    const rules = await tx.select({
      id: billAlertRules.id, kind: billAlertRules.kind, value: billAlertRules.value, active: billAlertRules.active, lastMatchedAt: billAlertRules.lastMatchedAt,
      createdAt: billAlertRules.createdAt, createdBy: users.name,
    }).from(billAlertRules).leftJoin(users, eq(users.id, billAlertRules.createdBy)).where(eq(billAlertRules.organizationId, ctx.orgId))
      .orderBy(asc(billAlertRules.createdAt));
    const hits = await tx.select({ ruleId: notifications.sourceId, n: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.organizationId, ctx.orgId), eq(notifications.sourceType, "bill_alert_rule"))).groupBy(notifications.sourceId);
    return { rules, hits };
  });
  const filed = new Map(hits.map((h) => [h.ruleId, h.n]));
  const out = [];
  for (const r of rules) {
    const m = await listBills(ctx, { ...alertFilter(r.kind, r.value), sort: "introduced", limit: 3 });
    out.push({ ...r, total: m.total, latest: m.items, filedSince: filed.get(r.id) ?? 0 });
  }
  return out;
}
