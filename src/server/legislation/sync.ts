import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { systemDb, type Db } from "../db/client";
import {
  amendments, billActions, billCommitteeLinks, bills, billSponsors, billStatusHistory, billVersions, committees, legislativeEvents, legislativeSessions,
  legislativeSourceSyncs, legislators, billRelations, rollCalls, rollCallVotes, trackedBills, type LegislativeProviderKey,
} from "../db/schema";
import { getEnv } from "../env";
import { sha256 } from "../crypto";
import { ensureJurisdiction } from "../services/offices";
import { enqueue } from "../jobs/queue";
import { matchAlertRules } from "./alerts";
import { logger } from "../logger";
import { LegiScanProvider } from "./providers/legiscan";
import { OpenStatesProvider } from "./providers/openstates";
import { registeredFixture } from "./providers/fixture";
import { ConnecticutProvider } from "./providers/connecticut";
import type { LegislativeProvider, NormalizedBill, NormalizedSession } from "./types";
import { extractCodeSections } from "./related";

export function providerFor(jurisdiction: string, prefer?: LegislativeProviderKey): LegislativeProvider | null {
  const env = getEnv();
  const fixture = registeredFixture();
  if (prefer === "fixture" || (fixture && (jurisdiction === "ZZ" || env.APP_ENV === "test"))) return fixture;
  if (jurisdiction === "CT") return new ConnecticutProvider();
  // The demo environment never calls live providers, even if a key is set.
  if (env.APP_ENV === "demo") return null;
  if (prefer === "openstates" && env.OPENSTATES_API_KEY) return new OpenStatesProvider();
  if (env.LEGISCAN_API_KEY) return new LegiScanProvider();
  if (env.OPENSTATES_API_KEY) return new OpenStatesProvider();
  return null;
}

function currentSessions(sessions: NormalizedSession[], now = new Date()) {
  const cutoff = new Date(now.getTime() - 365 * 86400_000).toISOString().slice(0, 10);
  return sessions.filter((s) => !s.endDate || s.endDate >= cutoff);
}

type Counts = { billsSeen: number; billsChanged: number; actionsAdded: number; versionsAdded: number };

type UpsertResult = Awaited<ReturnType<typeof upsertBill>>;

export async function syncJurisdiction(jurisdiction: string, opts: { provider?: LegislativeProvider | null; sessionIdentifiers?: string[] } = {}) {
  const provider = opts.provider ?? providerFor(jurisdiction);
  if (!provider) throw new Error(`No legislative data provider configured for ${jurisdiction} (set LEGISCAN_API_KEY or OPENSTATES_API_KEY).`);
  await ensureJurisdiction(jurisdiction);
  const db = await systemDb();
  const [run] = await db.insert(legislativeSourceSyncs).values({ provider: provider.key, jurisdictionCode: jurisdiction, status: "running" }).returning();
  const finish = (set: Partial<typeof legislativeSourceSyncs.$inferInsert>) =>
    db.update(legislativeSourceSyncs).set({ ...set, finishedAt: new Date() }).where(eq(legislativeSourceSyncs.id, run.id));
  const counts: Counts = { billsSeen: 0, billsChanged: 0, actionsAdded: 0, versionsAdded: 0 };
  const errors: string[] = [];
  const newActionIds: string[] = [];
  let bulkLoaded = 0;
  // A bill first stored in this run cannot be tracked yet, so it raises no alerts.
  const createdThisRun = new Set<string>();
  const record = (res: UpsertResult) => {
    counts.billsChanged++;
    counts.actionsAdded += res.newActionIds.length;
    counts.versionsAdded += res.versionsAdded;
    if (res.created) createdThisRun.add(res.billId);
    if (!createdThisRun.has(res.billId)) newActionIds.push(...res.newActionIds);
  };
  const fail = (id: string, e: unknown) => {
    errors.push(`${id}: ${(e as Error).message.slice(0, 160)}`);
    if (errors.length > 50) throw new Error(`Too many bill errors; last: ${errors[errors.length - 1]}`);
  };
  try {
    if (provider.hasNews && !(await provider.hasNews())) {
      await finish({ status: "succeeded" });
      return { syncId: run.id, status: "succeeded", ...counts, bulkLoaded, queries: provider.queries, errors, newActionIds };
    }
    const all = await provider.listSessions(jurisdiction);
    const sessions = opts.sessionIdentifiers ? all.filter((s) => opts.sessionIdentifiers!.includes(s.identifier)) : currentSessions(all);
    const tracked = new Set((await db.select({ id: trackedBills.billId }).from(trackedBills)).map((t) => t.id));
    for (const s of sessions) {
      const ids = { [provider.key]: s.providerId };
      const named = { name: s.name, startDate: s.startDate, endDate: s.endDate };
      const [session] = await db
        .insert(legislativeSessions)
        .values({ jurisdictionCode: jurisdiction, identifier: s.identifier, ...named, isSpecial: s.isSpecial, providerIds: ids })
        .onConflictDoUpdate({
          target: [legislativeSessions.jurisdictionCode, legislativeSessions.identifier],
          set: { ...named, providerIds: sql`${legislativeSessions.providerIds} || ${JSON.stringify(ids)}::jsonb` },
        })
        .returning();
      const held = await db
        .select({ pid: bills.providerBillId, hash: bills.providerChangeHash })
        .from(bills)
        .where(and(eq(bills.provider, provider.key), eq(bills.sessionId, session.id)));
      const known = new Map(held.map((b) => [b.pid, b.hash]));
      // Members load with a session's first load; they rarely change mid-session.
      if ((known.size === 0 || provider.wholeSession) && provider.listPeople) {
        try {
          for (const p of await provider.listPeople(jurisdiction, s)) {
            const seats = { committeeRoles: p.committeeRoles ?? [], title: p.title ?? null, contact: p.contact ?? {} };
            const person = { name: p.name, party: p.party, chamber: p.chamber, district: p.district };
            await db
              .insert(legislators)
              .values({ jurisdictionCode: jurisdiction, ...person, provider: provider.key, providerPersonId: p.providerPersonId, ...seats })
              .onConflictDoUpdate({ target: [legislators.provider, legislators.providerPersonId], set: { ...person, ...seats } });
          }
        } catch (e) {
          logger.warn("legislation.people_unavailable", { jurisdiction, session: s.identifier, error: (e as Error).message.slice(0, 160) });
        }
      }
      // First load of a session: one bulk snapshot instead of one query per bill.
      if (known.size === 0 && provider.bulkBills) {
        let bulk: NormalizedBill[] | null = null;
        try {
          bulk = await provider.bulkBills(jurisdiction, s);
        } catch (e) {
          logger.warn("legislation.bulk_unavailable", { jurisdiction, session: s.identifier, error: (e as Error).message.slice(0, 160) });
        }
        for (const nb of bulk ?? []) {
          try {
            record(await upsertBill(db, provider, jurisdiction, session.id, nb, run.id, tracked));
            known.set(nb.providerBillId, nb.changeHash);
            bulkLoaded++;
          } catch (e) {
            fail(nb.providerBillId, e);
          }
        }
      }
      const lastOk = await lastSuccessfulSync(provider.key, jurisdiction);
      const changed = await provider.listChangedBills(jurisdiction, s, lastOk?.finishedAt ?? null, known);
      counts.billsSeen += known.size + changed.filter((c) => !known.has(c.providerBillId)).length;
      for (const c of changed) {
        try {
          record(await upsertBill(db, provider, jurisdiction, session.id, await provider.getBill(jurisdiction, c.providerBillId), run.id, tracked));
        } catch (e) {
          fail(c.providerBillId, e);
        }
      }
    }
    const status = errors.length ? "partial" : "succeeded";
    await finish({ ...counts, status, error: errors.length ? errors.slice(0, 5).join("\n") : null });
    await provider.finished?.(status === "succeeded");
    if (newActionIds.length) await enqueue("legislation.alerts", { actionIds: newActionIds, syncId: run.id }, { idempotencyKey: `alerts:${run.id}` });
    try {
      await matchAlertRules(jurisdiction);
    } catch (e) {
      logger.warn("legislation.alert_rules_failed", { jurisdiction, error: (e as Error).message.slice(0, 120) });
    }
    const queries = provider.queries;
    logger.info("legislation.sync", { jurisdiction, provider: provider.key, ...counts, bulkLoaded, queries, errors: errors.length });
    return { syncId: run.id, status, ...counts, bulkLoaded, queries, errors, newActionIds };
  } catch (e) {
    await provider.finished?.(false);
    await finish({ ...counts, status: "failed", error: (e as Error).message.slice(0, 500) });
    throw e;
  }
}

export async function lastSuccessfulSync(provider: string, jurisdiction: string) {
  const db = await systemDb();
  const done = inArray(legislativeSourceSyncs.status, ["succeeded", "partial"]);
  const [row] = await db
    .select()
    .from(legislativeSourceSyncs)
    .where(and(eq(legislativeSourceSyncs.provider, provider as LegislativeProviderKey), eq(legislativeSourceSyncs.jurisdictionCode, jurisdiction), done))
    .orderBy(desc(legislativeSourceSyncs.finishedAt))
    .limit(1);
  return row ?? null;
}

async function upsertBill(
  db: Db, provider: LegislativeProvider, jurisdiction: string, sessionId: string, b: NormalizedBill, syncId: string, tracked: Set<string>,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bills).where(and(eq(bills.provider, provider.key), eq(bills.providerBillId, b.providerBillId)));
    const values = {
      jurisdictionCode: jurisdiction, sessionId, identifier: b.identifier, billType: b.billType, number: b.number, chamber: b.chamber, title: b.title,
      officialSummary: b.officialSummary, status: b.status, statusText: b.statusText, statusDate: b.statusDate, introducedAt: b.introducedAt,
      lastActionAt: b.lastActionAt, lastActionText: b.lastActionText, effectiveDate: b.effectiveDate, subjects: b.subjects,
      analysis: b.analysis ?? null, fiscal: b.fiscal ?? null,
      codeSections: [...new Set([...extractCodeSections(b.title, b.officialSummary), ...(b.codeSections ?? [])])],
      sourceUrls: b.sourceUrls, provider: provider.key, providerBillId: b.providerBillId, providerChangeHash: b.changeHash,
      sourceUpdatedAt: b.sourceUpdatedAt ? new Date(b.sourceUpdatedAt) : null, lastSyncedAt: new Date(),
    };
    let billId: string;
    if (existing) {
      billId = existing.id;
      // Keep sections found earlier in the text; the title alone names fewer.
      values.codeSections = [...new Set([...existing.codeSections, ...values.codeSections])];
      const retitled = existing.title !== b.title;
      if (existing.status !== b.status || retitled) {
        await tx.insert(billStatusHistory).values({
          billId, fromStatus: existing.status, toStatus: b.status, fromTitle: retitled ? existing.title : null, toTitle: retitled ? b.title : null,
          sourceDate: b.statusDate, syncId,
        });
      }
      const resetSummary = retitled || existing.officialSummary !== b.officialSummary;
      const cleared = resetSummary ? { plainSummary: null, plainSummaryModel: null, plainSummaryAt: null } : {};
      await tx.update(bills).set({ ...values, ...cleared }).where(eq(bills.id, billId));
    } else {
      const [created] = await tx.insert(bills).values(values).returning({ id: bills.id });
      billId = created.id;
      await tx.insert(billStatusHistory).values({ billId, fromStatus: null, toStatus: b.status, sourceDate: b.introducedAt, syncId });
    }

    const insertedActions = b.actions.length
      ? await tx
          .insert(billActions)
          .values(b.actions.map((a, i) => ({
            billId, providerKey: a.providerKey, actionDate: a.date, chamber: a.chamber, description: a.description,
            classification: a.classification, sequence: i,
          })))
          .onConflictDoNothing()
          .returning({ id: billActions.id })
      : [];

    // Refresh classifications and corrected dates; neither counts as a new action.
    if (existing && b.actions.length) {
      const rows = JSON.stringify(b.actions.map((a) => ({ key: a.providerKey, cls: a.classification, day: a.date })));
      await tx.execute(sql`
        update bill_actions a set classification = array(select jsonb_array_elements_text(x.cls)), action_date = x.day
        from jsonb_to_recordset(${rows}::jsonb) as x(key text, cls jsonb, day date)
        where a.bill_id = ${billId} and a.provider_key = x.key
          and (a.classification is distinct from array(select jsonb_array_elements_text(x.cls)) or a.action_date <> x.day)`);
    }

    const insertedVersions = b.versions.length
      ? await tx
          .insert(billVersions)
          .values(b.versions.map((v) => ({
            billId, providerVersionId: v.providerVersionId, label: v.label, versionDate: v.date, url: v.url, mimeType: v.mimeType,
            ...(v.text ? { textContent: v.text, textSha256: sha256(v.text), fetchedAt: new Date() } : {}),
          })))
          .onConflictDoNothing()
          .returning({ id: billVersions.id })
      : [];

    for (const [i, s] of b.sponsors.entries()) {
      let legislatorId: string | null = null;
      if (s.providerPersonId) {
        const [l] = await tx
          .insert(legislators)
          .values({
            jurisdictionCode: jurisdiction, name: s.name, party: s.party, chamber: s.chamber, district: s.district,
            provider: provider.key, providerPersonId: s.providerPersonId,
          })
          .onConflictDoUpdate({ target: [legislators.provider, legislators.providerPersonId], set: { name: s.name, party: s.party, district: s.district } })
          .returning({ id: legislators.id });
        legislatorId = l.id;
      }
      await tx.insert(billSponsors).values({ billId, legislatorId, name: s.name, sponsorType: s.type, sequence: i }).onConflictDoNothing();
    }

    for (const c of b.committees) {
      const [cm] = await tx
        .insert(committees)
        .values({ jurisdictionCode: jurisdiction, name: c.name, chamber: c.chamber, provider: provider.key, providerCommitteeId: c.providerCommitteeId })
        .onConflictDoUpdate({ target: [committees.provider, committees.providerCommitteeId], set: { name: c.name } })
        .returning({ id: committees.id });
      await tx.insert(billCommitteeLinks).values({ billId, committeeId: cm.id, referredAt: c.referredAt }).onConflictDoNothing();
    }

    for (const a of b.amendments) {
      await tx
        .insert(amendments)
        .values({
          billId, providerAmendmentId: a.providerAmendmentId, title: a.title, description: a.description, chamber: a.chamber, adopted: a.adopted,
          amendmentDate: a.date, url: a.url,
        })
        .onConflictDoUpdate({ target: [amendments.billId, amendments.providerAmendmentId], set: { adopted: a.adopted, title: a.title } });
    }

    for (const v of b.votes) {
      await tx
        .insert(rollCalls)
        .values({
          billId, providerRollCallId: v.providerRollCallId, voteDate: v.date, chamber: v.chamber, motion: v.motion,
          yes: v.yes, no: v.no, other: v.other, passed: v.passed, url: v.url,
        })
        .onConflictDoUpdate({
          target: [rollCalls.billId, rollCalls.providerRollCallId],
          set: { motion: v.motion, voteDate: v.date, yes: v.yes, no: v.no, other: v.other, passed: v.passed },
        });
    }

    // Member votes cost a query per roll call, so only tracked bills load them.
    if (provider.getRollCallVotes && (tracked.has(billId) || provider.key === "fixture" || provider.wholeSession)) await loadMemberVotes(tx, provider, billId);

    for (const e of b.events) {
      await tx
        .insert(legislativeEvents)
        .values({
          jurisdictionCode: jurisdiction, kind: e.kind, title: e.title, startsAt: new Date(e.startsAt), location: e.location, billIds: [billId],
          provider: provider.key, providerEventId: e.providerEventId,
        })
        .onConflictDoUpdate({
          target: [legislativeEvents.provider, legislativeEvents.providerEventId],
          set: {
            title: e.title, startsAt: new Date(e.startsAt), location: e.location,
            billIds: sql`array(select distinct unnest(${legislativeEvents.billIds} || excluded.bill_ids))`,
          },
        });
    }

    for (const r of b.relations ?? []) {
      await tx
        .insert(billRelations)
        .values({ billId, provider: provider.key, relatedProviderBillId: r.providerBillId, relatedIdentifier: r.identifier, kind: r.kind })
        .onConflictDoNothing();
    }

    // Only tracked bills fetch text up front (others on demand), to save queries.
    if ((tracked.has(billId) && !provider.wholeSession) || provider.key === "fixture") await fetchMissingTexts(tx, provider, jurisdiction, billId);
    return { billId, created: !existing, newActionIds: insertedActions.map((a) => a.id), versionsAdded: insertedVersions.length };
  });
}

async function loadMemberVotes(tx: Db, provider: LegislativeProvider, billId: string) {
  const recorded = sql<number>`(select count(*)::int from roll_call_votes v where v.roll_call_id = ${rollCalls.id})`;
  const calls = await tx.select({ id: rollCalls.id, pid: rollCalls.providerRollCallId, recorded }).from(rollCalls).where(eq(rollCalls.billId, billId));
  for (const c of calls.filter((x) => x.recorded === 0)) {
    try {
      const votes = await provider.getRollCallVotes!(c.pid);
      const ids = [...new Set(votes.map((v) => v.providerPersonId).filter((x): x is string => Boolean(x)))];
      const people = ids.length
        ? await tx
            .select({ id: legislators.id, pid: legislators.providerPersonId, name: legislators.name })
            .from(legislators)
            .where(and(eq(legislators.provider, provider.key), inArray(legislators.providerPersonId, ids)))
        : [];
      const byPid = new Map(people.map((p) => [p.pid, p]));
      const rows = votes.map((v) => {
        const person = v.providerPersonId ? byPid.get(v.providerPersonId) : undefined;
        return { rollCallId: c.id, legislatorId: person?.id ?? null, voterName: person?.name ?? v.name, vote: v.vote };
      });
      if (rows.length) await tx.insert(rollCallVotes).values(rows).onConflictDoNothing();
    } catch (e) {
      logger.warn("legislation.votes_failed", { billId, rollCall: c.pid, error: (e as Error).message.slice(0, 120) });
    }
  }
}

async function fetchMissingTexts(tx: Db, provider: LegislativeProvider, jurisdiction: string, billId: string) {
  const missing = await tx.select().from(billVersions).where(and(eq(billVersions.billId, billId), isNull(billVersions.textContent)));
  for (const v of missing) {
    try {
      const text = await provider.getVersionText(jurisdiction, { providerVersionId: v.providerVersionId, url: v.url, mimeType: v.mimeType });
      if (text) {
        await tx.update(billVersions).set({ textContent: text, textSha256: sha256(text), fetchedAt: new Date() }).where(eq(billVersions.id, v.id));
        const cited = extractCodeSections(text.slice(0, 40_000));
        const merged = sql`(select coalesce(array_agg(distinct c order by c), '{}') from unnest(${bills.codeSections} || ${cited}::text[]) as c)`;
        if (cited.length) await tx.update(bills).set({ codeSections: merged }).where(eq(bills.id, billId));
      }
    } catch (e) {
      logger.warn("legislation.text_failed", { billId, version: v.providerVersionId, error: (e as Error).message.slice(0, 120) });
    }
  }
}

export async function handleLegislativeSync(p: Record<string, unknown>) {
  if (providerFor(String(p.jurisdiction))?.isBusy?.()) return { skipped: "A sync is already running" };
  const r = await syncJurisdiction(String(p.jurisdiction), { sessionIdentifiers: p.sessions as string[] | undefined });
  return { syncId: r.syncId, status: r.status, billsChanged: r.billsChanged, actionsAdded: r.actionsAdded };
}
