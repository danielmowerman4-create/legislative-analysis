import { and, asc, eq, inArray, isNotNull, lt, notInArray, sql } from "drizzle-orm";
import { systemDb, withTenant } from "../db/client";
import { refreshStatisticsSoon } from "../db/maintenance";
import { emailConnections, emailSyncState, mailLedger, mailReconciliations } from "../db/schema";
import { getEnv } from "../env";
import { randomToken, sha256 } from "../crypto";
import { enqueue, RetryLaterError, type ClaimedJob } from "../jobs/queue";
import { ingestMessage, ledgerKey, recordLedgerFailure, recordLedgerOwed } from "../services/ingest";
import { answersOfficeMail } from "../services/answered";
import { logger } from "../logger";
import { getConnection, graphFor, recordIntegrationError, resolveIntegrationErrors, SENT_NAME, tokenProvider, withImap, type Connection } from "./connections";
import { normalizeRfc822, type NormalizedMessage } from "./normalize";
import { GmailClient } from "./providers/gmail";
import type { GraphClient } from "./providers/graph";
import { CursorExpiredError, ProviderHttpError } from "./providers/http";
import { imapMessageId, parseImapMessageId, type MailEnvelope } from "./providers/imap";

type SyncState = typeof emailSyncState.$inferSelect;
type Purpose = SyncState["purpose"];

const PAGES_PER_JOB = 5;
const FETCH_BATCH = 25;
const RECONCILE_DAYS = 3;
const REFUSALS_BEFORE_WAITING = 3;
const MAILBOX_WAIT_MS = 30_000;
const OWED_TRIES = 12;
// Gmail serves about 100 full messages a minute from one mailbox.
const OWED_PER_ROUND = 500;
const OWED_PER_NIGHT = 1000;
const OWED_BATCH_TRIES = 8;

const UNREADABLE = "This message could not be read.";
const GONE = "This message was no longer in the mailbox when it was asked for.";
const NOT_ASKED = "The mailbox stopped answering before this message was read in. It will be asked for again.";

async function syncStates(orgId: string, connectionId: string) {
  return withTenant({ orgId }, (tx) => tx.select().from(emailSyncState).where(eq(emailSyncState.connectionId, connectionId)));
}

async function updateState(orgId: string, id: string, values: Partial<typeof emailSyncState.$inferInsert>) {
  await withTenant({ orgId }, (tx) => tx.update(emailSyncState).set({ ...values, updatedAt: new Date() }).where(eq(emailSyncState.id, id)));
}

const updateConnection = (conn: Connection, values: Partial<typeof emailConnections.$inferInsert>) =>
  withTenant({ orgId: conn.organizationId }, (tx) => tx.update(emailConnections).set(values).where(eq(emailConnections.id, conn.id)));

const recordError = (conn: Connection, operation: string, code: string, message: string) =>
  recordIntegrationError(conn.organizationId, conn.id, conn.provider, operation, code, message);

class UnreadableMessage extends Error {}

const parse = (...args: Parameters<typeof normalizeRfc822>) =>
  normalizeRfc822(...args).catch(() => {
    throw new UnreadableMessage();
  });

// Sent Items is named in the mailbox's language; its id is fixed.
const sentItems = new Map<string, string>();
async function isSentItems(conn: Connection, folderId: string, folderName: string) {
  if (!sentItems.has(conn.id)) {
    const f = await graphFor(conn).sentFolder().catch(() => null);
    if (!f) return SENT_NAME.test(folderName);
    sentItems.set(conn.id, f.id);
  }
  return sentItems.get(conn.id) === folderId;
}

// Outbound only if the service filed it as sent; the From line decides nothing.
async function fetchNormalized(conn: Connection, id: string, sent = false): Promise<NormalizedMessage> {
  if (conn.provider === "imap") {
    const { folder, uidValidity, uid } = parseImapMessageId(id);
    const m = await withImap(conn, (s) => s.fetch(folder, uidValidity, uid));
    if (!m) throw new ProviderHttpError(404, "gone", "That message is no longer in the folder.");
    const filedSent = sent || SENT_NAME.test(folder);
    return parse(m.raw, { providerMessageId: id, providerThreadId: m.threadId, labels: [filedSent ? "SENT" : "INBOX"], receivedAt: m.receivedAt });
  }
  if (conn.provider === "google") {
    const m = await new GmailClient(tokenProvider(conn)).getRaw(id);
    return parse(m.raw, { providerMessageId: m.id, providerThreadId: m.threadId, labels: m.labels, receivedAt: m.receivedAt });
  }
  const g = graphFor(conn);
  const [meta, raw] = await Promise.all([g.getMeta(id), g.getRaw(id)]);
  const folderName = conn.selectedFolders.find((f) => f.id === meta.parentFolderId)?.name ?? "";
  const filedSent = sent || (await isSentItems(conn, meta.parentFolderId, folderName));
  const labels = [filedSent ? "SENT" : "INBOX"];
  return parse(raw.raw, { providerMessageId: meta.id, providerThreadId: meta.conversationId, labels, receivedAt: new Date(meta.receivedDateTime) });
}

async function fetchEnvelope(conn: Connection, id: string): Promise<MailEnvelope | null> {
  if (conn.provider === "imap") {
    const { folder, uidValidity, uid } = parseImapMessageId(id);
    return withImap(conn, (s) => s.envelope(folder, uidValidity, uid));
  }
  if (conn.provider === "google") return new GmailClient(tokenProvider(conn)).getEnvelope(id);
  return graphFor(conn).getEnvelope(id);
}

type ImportResult = "new" | "existing" | "failed" | "refused" | "passed_over";

async function importOne(conn: Connection, id: string, purpose: Purpose = "mail"): Promise<ImportResult> {
  let normalized: NormalizedMessage;
  try {
    if (purpose === "sent") {
      const envelope = await fetchEnvelope(conn, id);
      if (!envelope || !(await answersOfficeMail(conn.organizationId, conn.id, envelope))) return "passed_over";
    }
    normalized = await fetchNormalized(conn, id, purpose === "sent");
  } catch (e) {
    if (purpose === "sent" && (e instanceof UnreadableMessage || (e instanceof ProviderHttpError && e.status !== 401))) return "passed_over";
    if (e instanceof UnreadableMessage) {
      await recordLedgerFailure(conn.organizationId, conn.id, id, UNREADABLE);
      await recordError(conn, "fetch_message", "unparseable", "A message could not be read and was left for a person.");
      return "failed";
    }
    if (e instanceof ProviderHttpError && e.status !== 401) {
      const gone = e.status === 404 || e.status === 410;
      await recordLedgerFailure(conn.organizationId, conn.id, id, gone ? GONE : `The mailbox would not return this message (${e.status}).`);
      await recordError(conn, "fetch_message", e.code, `Could not fetch a message (${e.status}${e.reason ? ` ${e.reason}` : ""}).`);
      return e.status === 403 || e.status >= 500 ? "refused" : "failed";
    }
    throw e;
  }
  return (await ingestMessage(conn.organizationId, conn.id, normalized)).duplicate ? "existing" : "new";
}

async function settledProviderIds(orgId: string, connectionId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await withTenant({ orgId }, (tx) =>
    tx
      .select({ id: mailLedger.providerMessageId })
      .from(mailLedger)
      .where(and(
        eq(mailLedger.organizationId, orgId), inArray(mailLedger.sourceKey, ids.map((p) => ledgerKey(connectionId, p))),
        notInArray(mailLedger.disposition, ["failed", "pending"]),
      )),
  );
  return new Set(rows.map((r) => r.id!));
}

async function owedProviderIds(orgId: string, connectionId: string, opts: { limit: number; dueOnly: boolean }) {
  const rows = await withTenant({ orgId }, (tx) =>
    tx
      .select({ id: mailLedger.providerMessageId })
      .from(mailLedger)
      .where(
        and(
          eq(mailLedger.organizationId, orgId),
          eq(mailLedger.connectionId, connectionId),
          eq(mailLedger.disposition, "failed"),
          isNotNull(mailLedger.providerMessageId),
          sql`coalesce(${mailLedger.reason}, '') not in (${UNREADABLE}, ${GONE})`,
          ...(opts.dueOnly ? [lt(mailLedger.attempts, OWED_TRIES), sql`${mailLedger.createdAt} < now() - interval '10 minutes'`] : []),
        ),
      )
      .orderBy(asc(mailLedger.attempts), asc(mailLedger.createdAt), asc(mailLedger.id))
      .limit(opts.limit),
  );
  return rows.map((r) => r.id!);
}

async function refetchOwed(conn: Connection, nightly = false) {
  const ids = await owedProviderIds(conn.organizationId, conn.id, { limit: nightly ? OWED_PER_NIGHT : OWED_PER_ROUND, dueOnly: !nightly });
  const round = Math.floor(Date.now() / 600_000);
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const chunk = ids.slice(i, i + FETCH_BATCH);
    const payload = { connectionId: conn.id, ids: chunk, stateId: null, purpose: "mail", again: true };
    const idempotencyKey = `refetch:${conn.id}:${round}:${sha256(chunk.join(","))}`;
    await enqueue("mail.fetch_batch", payload, { orgId: conn.organizationId, maxAttempts: OWED_BATCH_TRIES, idempotencyKey });
  }
  return ids.length;
}

async function settleProblems(conn: Connection) {
  const { organizationId: orgId, id } = conn;
  if (!(await owedProviderIds(orgId, id, { limit: 1, dueOnly: false })).length) {
    await resolveIntegrationErrors(orgId, id, ["fetch_message", "rate_limit"], { exceptCode: "unparseable" });
  }
  const states = await syncStates(orgId, id);
  if (states.length && states.every((s) => s.backfillStatus === "completed")) await resolveIntegrationErrors(orgId, id, ["backfill"]);
  const checked = states.map((s) => s.lastReconciledAt?.getTime() ?? 0);
  if (checked.length && Math.min(...checked) > 0) await resolveIntegrationErrors(orgId, id, ["reconcile"], { lastSeenBefore: new Date(Math.min(...checked)) });
}

async function withSyncErrors<T>(conn: Connection, operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn();
    await updateConnection(conn, { lastSyncedAt: new Date(), lastError: null });
    await resolveIntegrationErrors(conn.organizationId, conn.id, [operation, "login", "token_refresh", "cursor_expired"]);
    return r;
  } catch (e) {
    const code = e instanceof ProviderHttpError ? e.code : e instanceof Error ? e.constructor.name : "error";
    await recordError(conn, operation, code, (e as Error).message.slice(0, 300));
    await updateConnection(conn, { lastError: (e as Error).message.slice(0, 300) });
    throw e;
  }
}

// Cursor first, so mail arriving during the import is not missed.
export async function handleBackfill(p: Record<string, unknown>, job: ClaimedJob) {
  const orgId = job.organizationId!;
  const conn = await getConnection(orgId, String(p.connectionId));
  if (conn.status !== "active") return { skipped: conn.status };
  const after = new Date(`${conn.importFrom}T00:00:00Z`);
  const before = conn.importTo ? new Date(`${conn.importTo}T23:59:59Z`) : undefined;
  const all = await syncStates(orgId, conn.id);
  const sentPass = p.sent === true;
  const chain = typeof p.chain === "string" ? p.chain : randomToken(6);
  const startSentPass = async () => {
    if (!sentPass) await startSentPassWhenReady(conn, chain);
  };
  if (sentPass) {
    const waits = Number(p.waits ?? 0);
    if (all.some((s) => s.purpose === "mail" && s.backfillStatus !== "completed") && waits < 120) {
      const idempotencyKey = `backfill-sent:${conn.id}:${chain}:${waits + 1}`;
      const runAt = new Date(Date.now() + 30_000);
      await enqueue("mail.backfill", { connectionId: conn.id, sent: true, chain, waits: waits + 1 }, { orgId, runAt, idempotencyKey });
      return { waiting: true };
    }
  }
  const states = all.filter((s) => (s.purpose === "sent") === sentPass);
  const fetchAll = async (ids: string[], stateId: string | null, purpose: Purpose) => {
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      const chunk = ids.slice(i, i + FETCH_BATCH);
      const idempotencyKey = `fetch:${conn.id}:${purpose}:${sha256(chunk.join(","))}`;
      await enqueue("mail.fetch_batch", { connectionId: conn.id, ids: chunk, stateId, purpose, chain }, { orgId, idempotencyKey });
    }
  };

  return withSyncErrors(conn, "backfill", async () => {
    let pages = 0;
    let listed = 0;
    if (conn.provider === "imap") {
      for (const state of states) {
        if (state.backfillStatus === "fetching" || state.backfillStatus === "completed") continue;
        const found = await withImap(conn, (s) => s.search(state.folderId, { since: after, before }));
        const ids = found.uids.map((uid) => imapMessageId(state.folderId, found.uidValidity, uid));
        await fetchAll(ids, state.id, state.purpose);
        const cursor = `${found.uidValidity}:${found.uidNext - 1}`;
        await updateState(orgId, state.id, { cursor, backfillListed: ids.length, backfillStatus: ids.length ? "fetching" : "completed" });
        listed += ids.length;
      }
      await startSentPass();
      return { listed, done: true };
    }
    if (conn.provider === "google") {
      const gmail = new GmailClient(tokenProvider(conn));
      const state = all[0];
      if (sentPass) {
        let pageToken: string | null = typeof p.pageToken === "string" ? p.pageToken : null;
        do {
          const page = await gmail.listMessages({ labelId: conn.sentFolder!.id, after, before, pageToken });
          const ids = (page.messages ?? []).map((m) => m.id);
          await fetchAll(ids, null, "sent");
          listed += ids.length;
          pages++;
          pageToken = page.nextPageToken ?? null;
        } while (pageToken && pages < PAGES_PER_JOB);
        if (pageToken) {
          const idempotencyKey = `backfill-sent:${conn.id}:${chain}:${sha256(pageToken)}`;
          await enqueue("mail.backfill", { connectionId: conn.id, sent: true, chain, waits: 120, pageToken }, { orgId, idempotencyKey });
        }
        return { listed, done: !pageToken };
      }
      if (!state.cursor) {
        const profile = await gmail.getProfile();
        await updateState(orgId, state.id, { cursor: profile.historyId, backfillStatus: "listing" });
      }
      const folders = conn.selectedFolders;
      // backfillPageToken is "<folderIndex>:<token>"
      const [folderIdx, savedToken] = (state.backfillPageToken ?? "0:").split(/:(.*)/s) as [string, string];
      let pageToken = savedToken;
      let fi = Number(folderIdx) || 0;
      while (fi < folders.length && pages < PAGES_PER_JOB) {
        const page = await gmail.listMessages({ labelId: folders[fi].id, after, before, pageToken: pageToken || null });
        const ids = (page.messages ?? []).map((m) => m.id);
        await fetchAll(ids, state.id, "mail");
        listed += ids.length;
        pages++;
        if (page.nextPageToken) pageToken = page.nextPageToken;
        else {
          fi++;
          pageToken = "";
        }
      }
      const done = fi >= folders.length;
      await recordListed(orgId, state.id, listed, done ? null : `${fi}:${pageToken}`);
      if (done) {
        await ensurePush(conn);
        await startSentPass();
      } else {
        const idempotencyKey = `backfill-cont:${conn.id}:${fi}:${sha256(pageToken)}`;
        await enqueue("mail.backfill", { connectionId: conn.id, chain }, { orgId, idempotencyKey });
      }
      return { listed, done };
    }

    const graph = graphFor(conn);
    let allDone = true;
    for (const state of states) {
      if (state.backfillStatus === "fetching" || state.backfillStatus === "completed") continue;
      if (!state.cursor) {
        const d = await graph.delta(state.folderId, null);
        await updateState(orgId, state.id, { cursor: d.deltaLink, backfillStatus: "listing" });
      }
      let next = state.backfillPageToken;
      let statePages = 0;
      let stateListed = 0;
      do {
        const page = await graph.listMessages(state.folderId, { after, before, nextLink: next });
        const ids = page.value.map((m) => m.id);
        await fetchAll(ids, state.id, state.purpose);
        stateListed += ids.length;
        next = page["@odata.nextLink"] ?? null;
        statePages++;
        pages++;
      } while (next && statePages < PAGES_PER_JOB);
      listed += stateListed;
      await recordListed(orgId, state.id, stateListed, next);
      if (next) {
        allDone = false;
        break;
      }
    }
    if (!allDone) {
      const payload = { connectionId: conn.id, chain, ...(sentPass ? { sent: true, waits: 120 } : {}) };
      await enqueue("mail.backfill", payload, { orgId, idempotencyKey: `backfill-cont:${conn.id}:${randomToken(6)}` });
    }
    else if (!sentPass) {
      await ensurePush(conn);
      await startSentPass();
    }
    return { listed, pages, done: allDone };
  });
}

// With nothing listed no fetch batch will finish the import, so finish it here.
const recordListed = (orgId: string, stateId: string, listed: number, pageToken: string | null) =>
  withTenant({ orgId }, (tx) =>
    tx
      .update(emailSyncState)
      .set({
        backfillListed: sql`${emailSyncState.backfillListed} + ${listed}`, backfillPageToken: pageToken,
        backfillStatus: pageToken ? "listing" : sql`case when ${emailSyncState.backfillListed} + ${listed} = 0 then 'completed' else 'fetching' end`,
        updatedAt: new Date(),
      })
      .where(eq(emailSyncState.id, stateId)),
  );

async function startSentPassWhenReady(conn: Connection, chain: string) {
  if (!conn.sentFolder) return;
  const states = await syncStates(conn.organizationId, conn.id);
  if (states.some((s) => s.purpose === "mail" && s.backfillStatus !== "completed")) return;
  const idempotencyKey = `backfill-sent:${conn.id}:${chain}:0`;
  await enqueue("mail.backfill", { connectionId: conn.id, sent: true, chain, waits: 0 }, { orgId: conn.organizationId, idempotencyKey });
}

export async function handleFetchBatch(p: Record<string, unknown>, job: ClaimedJob) {
  const orgId = job.organizationId!;
  const conn = await getConnection(orgId, String(p.connectionId));
  const ids = (p.ids as string[]) ?? [];
  const purpose: Purpose = p.purpose === "sent" ? "sent" : "mail";
  const have = await settledProviderIds(orgId, conn.id, ids);
  const lastTry = job.attempts >= job.maxAttempts;
  let imported = 0;
  let failed = 0;
  let refusedInARow = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (have.has(id)) continue;
    let result: ImportResult | "rate_limited";
    try {
      result = await importOne(conn, id, purpose);
    } catch (e) {
      if (e instanceof RetryLaterError) await recordError(conn, "rate_limit", "rate_limit", e.message.slice(0, 200));
      if (!(e instanceof RetryLaterError) || !lastTry) throw e;
      result = "rate_limited";
    }
    if (result === "new") imported++;
    else if (result === "failed" || result === "refused") failed++;
    refusedInARow = result === "refused" ? refusedInARow + 1 : 0;
    if (result !== "rate_limited" && refusedInARow < REFUSALS_BEFORE_WAITING) continue;
    // A refetch round doesn't wait: each refusal uses a try and rounds are close.
    if (!lastTry && !p.again) throw new RetryLaterError("The mailbox is refusing requests for now", MAILBOX_WAIT_MS * 2 ** (job.attempts - 1));
    const rest = purpose === "mail" ? ids.slice(result === "rate_limited" ? i : i + 1).filter((x) => !have.has(x)) : [];
    await recordLedgerOwed(orgId, conn.id, rest, NOT_ASKED);
    failed += rest.length;
    break;
  }
  if (p.stateId) {
    await withTenant({ orgId }, async (tx) => {
      await tx
        .update(emailSyncState)
        .set({
          backfillFetched: sql`${emailSyncState.backfillFetched} + ${ids.length - failed}`, backfillFailed: sql`${emailSyncState.backfillFailed} + ${failed}`,
          updatedAt: new Date(),
        })
        .where(eq(emailSyncState.id, String(p.stateId)));
      await tx
        .update(emailSyncState)
        .set({ backfillStatus: "completed", lastSuccessAt: new Date() })
        .where(and(
          eq(emailSyncState.id, String(p.stateId)), eq(emailSyncState.backfillStatus, "fetching"),
          sql`${emailSyncState.backfillFetched} + ${emailSyncState.backfillFailed} >= ${emailSyncState.backfillListed}`,
        ));
    });
    if (purpose === "mail" && typeof p.chain === "string") await startSentPassWhenReady(conn, p.chain);
  }
  if (imported) refreshStatisticsSoon();
  return { imported, failed, skipped: have.size };
}

// The cursor moves only once the round is stored; replays are deduplicated.
export async function handleIncremental(p: Record<string, unknown>, job: ClaimedJob) {
  const orgId = job.organizationId!;
  const conn = await getConnection(orgId, String(p.connectionId));
  if (conn.status !== "active") return { skipped: conn.status };
  // Mail before Sent: a reply is recognized by the letter it answers.
  const states = (await syncStates(orgId, conn.id))
    .filter((s) => !p.folderId || s.folderId === p.folderId)
    .sort((a, b) => Number(a.purpose === "sent") - Number(b.purpose === "sent"));

  return withSyncErrors(conn, "incremental", async () => {
    let imported = 0;
    let recovered = false;
    for (const state of states) {
      try {
        const round = conn.provider === "google" ? gmailRound : conn.provider === "imap" ? imapRound : graphRound;
        imported += await round(conn, state);
        await updateState(orgId, state.id, { lastIncrementalAt: new Date(), lastSuccessAt: new Date(), consecutiveFailures: 0 });
      } catch (e) {
        if (!(e instanceof CursorExpiredError)) {
          await updateState(orgId, state.id, { consecutiveFailures: state.consecutiveFailures + 1 });
          throw e;
        }
        recovered = true;
        imported += await recoverExpiredCursor(conn, state);
      }
    }
    if (imported) refreshStatisticsSoon();
    const owed = p.folderId ? 0 : await refetchOwed(conn);
    return { imported, recovered, owed };
  }).then(async (r) => {
    if (!p.folderId) await settleProblems(conn);
    return r;
  });
}

async function importMissing(conn: Connection, ids: string[], purpose: Purpose = "mail") {
  const have = await settledProviderIds(conn.organizationId, conn.id, ids);
  let n = 0;
  for (const id of ids) if (!have.has(id) && (await importOne(conn, id, purpose)) === "new") n++;
  return n;
}

async function gmailRound(conn: Connection, state: SyncState) {
  if (!state.cursor) throw new CursorExpiredError("No Gmail cursor yet");
  const gmail = new GmailClient(tokenProvider(conn));
  const { added, historyId } = await gmail.historySince(state.cursor);
  const wanted = new Set(conn.selectedFolders.map((f) => f.id));
  const relevant = added.filter((a) => a.labels.some((l) => wanted.has(l)) || a.labels.length === 0);
  const sentOnly = conn.sentFolder ? added.filter((a) => a.labels.includes(conn.sentFolder!.id) && !relevant.includes(a)) : [];
  const have = await settledProviderIds(conn.organizationId, conn.id, [...relevant, ...sentOnly].map((r) => r.id));
  let n = 0;
  for (const a of relevant) if (!have.has(a.id) && (await importOne(conn, a.id)) === "new") n++;
  for (const a of sentOnly) if (!have.has(a.id) && (await importOne(conn, a.id, "sent")) === "new") n++;
  await updateState(conn.organizationId, state.id, { cursor: historyId });
  return n;
}

async function imapRound(conn: Connection, state: SyncState) {
  const [uidValidity, last] = (state.cursor ?? "").split(":");
  if (!uidValidity) throw new CursorExpiredError("No IMAP cursor yet");
  const found = await withImap(conn, (s) => s.newerThan(state.folderId, Number(last)));
  if (found.uidValidity !== uidValidity) throw new CursorExpiredError("The mail server renumbered this folder");
  const ids = found.uids.map((uid) => imapMessageId(state.folderId, found.uidValidity, uid));
  const n = await importMissing(conn, ids, state.purpose);
  await updateState(conn.organizationId, state.id, { cursor: `${uidValidity}:${Math.max(Number(last), ...found.uids)}` });
  return n;
}

async function graphRound(conn: Connection, state: SyncState) {
  const { changed, deltaLink } = await graphFor(conn).delta(state.folderId, state.cursor);
  const floor = conn.importFrom ? new Date(`${conn.importFrom}T00:00:00Z`) : new Date(0);
  const fresh = changed.filter((c) => !c.receivedDateTime || new Date(c.receivedDateTime) >= floor);
  const n = await importMissing(conn, fresh.map((c) => c.id), state.purpose);
  if (deltaLink) await updateState(conn.organizationId, state.id, { cursor: deltaLink });
  return n;
}

const mailStates = async (conn: Connection) => (await syncStates(conn.organizationId, conn.id)).filter((s) => s.purpose === "mail");

async function gmailIdsSince(gmail: GmailClient, labelId: string, since: Date) {
  const ids: string[] = [];
  let pageToken: string | null = null;
  do {
    const page: { messages?: { id: string }[]; nextPageToken?: string } = await gmail.listMessages({ labelId, after: since, pageToken });
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  return ids;
}

async function listSince(conn: Connection, since: Date, folderId?: string) {
  const ids: string[] = [];
  if (conn.provider === "imap") {
    for (const s of folderId ? [{ folderId }] : await mailStates(conn)) {
      const found = await withImap(conn, (session) => session.search(s.folderId, { since }));
      ids.push(...found.uids.map((uid) => imapMessageId(s.folderId, found.uidValidity, uid)));
    }
    return ids;
  }
  if (conn.provider === "google") {
    const gmail = new GmailClient(tokenProvider(conn));
    for (const f of conn.selectedFolders) ids.push(...(await gmailIdsSince(gmail, f.id, since)));
    return ids;
  }
  const graph = graphFor(conn);
  for (const s of folderId ? [{ folderId }] : await mailStates(conn)) {
    let next: string | null = null;
    do {
      const page: { value: { id: string }[]; "@odata.nextLink"?: string } = await graph.listMessages(s.folderId, { after: since, nextLink: next });
      ids.push(...page.value.map((m) => m.id));
      next = page["@odata.nextLink"] ?? null;
    } while (next);
  }
  return ids;
}

async function listSentSince(conn: Connection, since: Date) {
  if (!conn.sentFolder) return [];
  if (conn.provider !== "google") return listSince(conn, since, conn.sentFolder.id);
  return gmailIdsSince(new GmailClient(tokenProvider(conn)), conn.sentFolder.id, since);
}

async function recoverExpiredCursor(conn: Connection, state: SyncState) {
  const floor = conn.importFrom ? new Date(`${conn.importFrom}T00:00:00Z`).getTime() : 0;
  const since = new Date(Math.max((state.lastSuccessAt ?? state.updatedAt).getTime() - 86400_000, floor));
  logger.warn("sync.cursor_expired", { connectionId: conn.id, provider: conn.provider });
  await recordError(conn, "cursor_expired", "cursor_expired", "Sync cursor expired; re-listed recent mail to recover.");
  const ids = await listSince(conn, since, conn.provider === "google" ? undefined : state.folderId);
  const n = await importMissing(conn, ids, state.purpose);
  const cursor =
    conn.provider === "imap"
      ? await withImap(conn, (s) => s.search(state.folderId, { since: new Date() })).then((now) => `${now.uidValidity}:${now.uidNext - 1}`)
      : conn.provider === "google"
        ? (await new GmailClient(tokenProvider(conn)).getProfile()).historyId
        : (await graphFor(conn).delta(state.folderId, null)).deltaLink;
  await updateState(conn.organizationId, state.id, { cursor, lastCursorResetAt: new Date(), lastSuccessAt: new Date() });
  return n;
}

async function subscribe(graph: GraphClient, orgId: string, state: SyncState) {
  const clientState = randomToken(24);
  const sub = await graph.createSubscription(state.folderId, clientState);
  await updateState(orgId, state.id, { subscriptionId: sub.id, subscriptionExpiresAt: new Date(sub.expirationDateTime), clientStateHash: sha256(clientState) });
}

async function ensurePush(conn: Connection) {
  const env = getEnv();
  if (conn.provider === "imap") return { push: "checked_every_ten_minutes" };
  const states = await syncStates(conn.organizationId, conn.id);
  if (conn.provider === "google") {
    if (!env.GOOGLE_PUBSUB_TOPIC) return { push: "not_configured" };
    const w = await new GmailClient(tokenProvider(conn)).watch(env.GOOGLE_PUBSUB_TOPIC, conn.selectedFolders.map((f) => f.id));
    await updateState(conn.organizationId, states[0].id, { subscriptionId: `gmail-watch:${conn.emailAddress}`, subscriptionExpiresAt: w.expiresAt });
    return { push: "watching" };
  }
  if (!env.APP_URL.startsWith("https://")) return { push: "requires_https" };
  const graph = graphFor(conn);
  for (const s of states) await subscribe(graph, conn.organizationId, s);
  return { push: "subscribed" };
}

export async function handleRenewSubscriptions() {
  const db = await systemDb();
  const conns = await db.select().from(emailConnections).where(eq(emailConnections.status, "active"));
  let renewed = 0;
  for (const conn of conns) {
    if (conn.provider === "imap") continue;
    try {
      if (conn.provider === "google") {
        await ensurePush(conn);
        renewed++;
        continue;
      }
      const states = await syncStates(conn.organizationId, conn.id);
      const graph = graphFor(conn);
      for (const s of states) {
        if (s.subscriptionExpiresAt && s.subscriptionExpiresAt.getTime() - Date.now() > 24 * 3600_000) continue;
        try {
          if (!s.subscriptionId) throw new ProviderHttpError(404, "missing", "no subscription");
          const r = await graph.renewSubscription(s.subscriptionId);
          await updateState(conn.organizationId, s.id, { subscriptionExpiresAt: new Date(r.expirationDateTime) });
        } catch (e) {
          if (e instanceof ProviderHttpError && e.status === 404) await subscribe(graph, conn.organizationId, s);
          else throw e;
        }
        renewed++;
      }
    } catch (e) {
      await recordError(conn, "renew_subscription", e instanceof ProviderHttpError ? e.code : "error", (e as Error).message.slice(0, 300));
    }
  }
  return { renewed };
}

export async function handleReconcile(p: Record<string, unknown>, job: ClaimedJob) {
  const orgId = job.organizationId!;
  const conn = await getConnection(orgId, String(p.connectionId));
  if (conn.status !== "active") return { skipped: conn.status };
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - RECONCILE_DAYS * 86400_000);
  let repaired = 0;
  let stillMissing = 0;
  let mailboxCount = 0;
  let ledgerCount = 0;
  await withSyncErrors(conn, "reconcile", async () => {
    const ids = [...new Set(await listSince(conn, windowStart))];
    mailboxCount = ids.length;
    const have = await settledProviderIds(orgId, conn.id, ids);
    ledgerCount = have.size;
    for (const id of ids) if (!have.has(id)) await importOne(conn, id);
    const after = await settledProviderIds(orgId, conn.id, ids);
    repaired = after.size - have.size;
    stillMissing = ids.length - after.size;
    for (const s of await syncStates(orgId, conn.id)) await updateState(orgId, s.id, { lastReconciledAt: new Date() });
    const sentIds = await listSentSince(conn, windowStart);
    await importMissing(conn, sentIds, "sent");
  });
  const status = stillMissing ? "gap" : repaired ? "repaired" : "matched";
  await withTenant({ orgId }, (tx) =>
    tx
      .insert(mailReconciliations)
      .values({ organizationId: orgId, connectionId: conn.id, windowStart, windowEnd, mailboxCount, ledgerCount, repaired, stillMissing, status }),
  );
  if (stillMissing) {
    logger.warn("sync.reconcile_gap", { connectionId: conn.id, stillMissing });
    await recordError(conn, "reconcile_gap", "gap", `${stillMissing} message${stillMissing === 1 ? "" : "s"} in the mailbox could not be recorded.`);
  } else await resolveIntegrationErrors(orgId, conn.id, ["reconcile_gap"]);
  const owed = await refetchOwed(conn, true);
  await settleProblems(conn);
  return { mailboxCount, ledgerCount, repaired, stillMissing, owed };
}
