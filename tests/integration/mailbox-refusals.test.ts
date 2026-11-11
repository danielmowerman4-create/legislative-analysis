import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { freshDatabase, makeOffice as newOffice } from "../helpers/db";
import { connectFakeGmail, syncState } from "../helpers/mailbox";
import { enableConstituentCenter, ledgerOverview, setupStatus } from "@/server/services/center";
import { lastErrorText, problemLines, problemText } from "@/lib/mailbox-problems";
import { systemDb, withTenant } from "@/server/db/client";
import { backgroundJobs, emailMessages, integrationErrors, mailLedger } from "@/server/db/schema";
import { enqueue, RetryLaterError } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { checked, ProviderHttpError, setProviderFetchForTests } from "@/server/email/providers/http";
import type { FakeGmail } from "../helpers/fake-gmail";

afterAll(() => setProviderFetchForTests(null));

async function makeOffice() {
  const office = await newOffice();
  await enableConstituentCenter(office.orgId);
  return office;
}

// Dated before the window the nightly count looks back over.
function fill(gmail: FakeGmail, n: number) {
  const date = new Date(Date.now() - 10 * 86400_000);
  for (let i = 1; i <= n; i++) gmail.add({ from: `writer${i}@gmail.com`, fromName: `Writer ${i}`, subject: `Letter ${i}`, date,
    body: `Dear Representative,\n\nThis is letter number ${i} about the road on my street.\n\nThank you.` });
}

// The app waits in real time; here every waiting job is made due at once.
async function endWaits() {
  const db = await systemDb();
  await db.update(backgroundJobs).set({ runAt: new Date() }).where(eq(backgroundJobs.status, "queued"));
}

async function drainThroughWaits(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await drainJobs();
    await endWaits();
  }
  await drainJobs();
}

const stored = async (orgId: string) =>
  (await withTenant({ orgId }, (tx) => tx.select({ n: count() }).from(emailMessages).where(eq(emailMessages.organizationId, orgId))))[0].n;
const failedRows = (orgId: string) => withTenant({ orgId }, (tx) => tx.select({ reason: mailLedger.reason, attempts: mailLedger.attempts,
  pid: mailLedger.providerMessageId }).from(mailLedger).where(and(eq(mailLedger.organizationId, orgId), eq(mailLedger.disposition, "failed"))));

async function tenMinutesLater(orgId: string) {
  const db = await systemDb();
  await db.update(mailLedger).set({ createdAt: sql`${mailLedger.createdAt} - interval '11 minutes'` }).where(eq(mailLedger.organizationId, orgId));
}

const problemsShown = async (ctx: Parameters<typeof setupStatus>[0]) => problemLines((await setupStatus(ctx)).errors).map((p) => p.text);

describe("a mailbox that turns requests away", () => {
  beforeAll(async () => {
    await freshDatabase();
  });

  it("waits and finishes the import when the mailbox refuses for a moment", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.wait@house.example.gov");
    fill(gmail, 60);
    gmail.refuseMessages = { status: 403, afterGets: 30 };
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();

    expect(await stored(office.orgId)).toBe(30);
    const asked = gmail.requests.filter((r) => /\/messages\/[^/]+$/.test(r)).length;
    expect(asked).toBeLessThanOrEqual(30 + 3 * 3);
    const db = await systemDb();
    const waiting = await db.select({ runAt: backgroundJobs.runAt, attempts: backgroundJobs.attempts }).from(backgroundJobs)
      .where(and(eq(backgroundJobs.name, "mail.fetch_batch"), eq(backgroundJobs.status, "queued")));
    expect(waiting.length).toBeGreaterThan(0);
    for (const w of waiting) expect(w.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await syncState(office.orgId, conn.id)).backfillStatus).toBe("fetching");

    gmail.refuseMessages = null;
    await drainThroughWaits(2);
    expect(await stored(office.orgId)).toBe(60);
    expect(await failedRows(office.orgId)).toHaveLength(0);
    const state = await syncState(office.orgId, conn.id);
    expect(state.backfillStatus).toBe("completed");
    expect(state.backfillFetched).toBe(60);
    expect(state.backfillFailed).toBe(0);
    const o = await ledgerOverview(office.ctx);
    expect(o.total).toBe(60);
    expect(o.byDisposition.failed ?? 0).toBe(0);

    expect(await problemsShown(office.ctx))
      .toEqual(["Some messages could not be fetched from the mailbox. They are asked for again every ten minutes and are listed under Every message."]);
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "wait-settle" });
    await drainJobs();
    expect(await problemsShown(office.ctx)).toEqual([]);
    const kept = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ resolvedAt: integrationErrors.resolvedAt }).from(integrationErrors).where(eq(integrationErrors.organizationId, office.orgId)));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((k) => k.resolvedAt !== null)).toBe(true);
  });

  it("stops showing a failed look, import or nightly check once one has worked, and never shows the mail service's own wording", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.clear@house.example.gov");
    fill(gmail, 3);
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    expect(await problemsShown(office.ctx)).toEqual([]);

    gmail.failNextWith = 500;
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "clear-look-1", maxAttempts: 1 });
    await drainJobs();
    gmail.failNextWith = 500;
    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "clear-night-1", maxAttempts: 1 });
    await drainJobs();
    const status = await setupStatus(office.ctx);
    expect(status.errors.map((e) => e.operation).sort()).toEqual(["incremental", "reconcile"]);
    expect(status.errors.every((e) => /failed \(500/.test(e.message))).toBe(true);
    expect(problemLines(status.errors).map((p) => p.text))
      .toEqual(["The mail service did not answer when it was asked for mail. It is asked again every ten minutes."]);
    expect(lastErrorText(status.mailboxes[0].lastError!))
      .toBe("The mail service did not answer when it was asked for mail. It is asked again every ten minutes.");

    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "clear-look-2" });
    await drainJobs();
    const after = await setupStatus(office.ctx);
    expect(after.errors.map((e) => e.operation)).toEqual(["reconcile"]);
    expect(after.mailboxes[0].lastError).toBeNull();
    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "clear-night-2" });
    await drainJobs();
    expect(await problemsShown(office.ctx)).toEqual([]);

    const db = await systemDb();
    await db.update(integrationErrors).set({ resolvedAt: null, lastSeenAt: new Date(Date.now() - 3600_000) })
      .where(and(eq(integrationErrors.organizationId, office.orgId), eq(integrationErrors.operation, "reconcile")));
    expect(await problemsShown(office.ctx)).toHaveLength(1);
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "clear-look-3" });
    await drainJobs();
    expect(await problemsShown(office.ctx)).toEqual([]);

    expect(problemText({ operation: "rate_limit", errorCode: "rate_limit", message: "Gmail get: provider rate limit (403 rateLimitExceeded)" }))
      .toBe("The mail service limits how fast mail can be read. The rest is being read in at that pace.");
    expect(problemText({ operation: "incremental", errorCode: "RetryLaterError", message: "Gmail history: provider rate limit (429)" }))
      .toBe("The mail service limits how fast mail can be read. The rest is being read in at that pace.");
    expect(problemText({ operation: "token_refresh", errorCode: "invalid_grant", message: "Authorization revoked or expired; reconnect required." }))
      .toBe("The sign-in for this mailbox has ended. Connect the mailbox again.");
    expect(problemText({ operation: "cursor_expired", errorCode: "cursor_expired", message: "Sync cursor expired; re-listed recent mail to recover." }))
      .toBeNull();
    expect(problemText({ operation: "fetch_message", errorCode: "unparseable", message: "A message could not be read and was left for a person." }))
      .toBe("A message could not be read and was left for a person.");
    expect(lastErrorText("Gmail list: provider rate limit (429)"))
      .toBe("The mail service limits how fast mail can be read. The rest is being read in at that pace.");
    expect(lastErrorText("Mailbox is disconnected")).toBe("The sign-in for this mailbox has ended. Connect the mailbox again.");
  });

  it("writes down what a longer refusal left behind and asks for it again until it has it", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.owed@house.example.gov");
    fill(gmail, 60);
    gmail.refuseMessages = { status: 403, afterGets: 10 };
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainThroughWaits();

    expect(await stored(office.orgId)).toBe(10);
    const owed = await failedRows(office.orgId);
    expect(owed).toHaveLength(50);
    expect(owed.some((r) => r.reason === "The mailbox would not return this message (403).")).toBe(true);
    expect(owed.some((r) => r.reason?.startsWith("The mailbox stopped answering"))).toBe(true);
    const state = await syncState(office.orgId, conn.id);
    expect(state.backfillStatus).toBe("completed");
    expect(state.backfillFetched + state.backfillFailed).toBe(60);
    const db = await systemDb();
    expect(await db.select({ id: backgroundJobs.id }).from(backgroundJobs)
      .where(and(eq(backgroundJobs.organizationId, office.orgId), eq(backgroundJobs.status, "dead")))).toHaveLength(0);
    expect((await ledgerOverview(office.ctx)).byDisposition.failed).toBe(50);

    await tenMinutesLater(office.orgId);
    const before = gmail.requests.length;
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "owed-round-1" });
    await drainThroughWaits(3);
    expect(await stored(office.orgId)).toBe(10);
    expect(await failedRows(office.orgId)).toHaveLength(50);
    expect(gmail.requests.slice(before).filter((r) => /\/messages\/[^/]+$/.test(r)).length).toBe(2 * 3);

    // The mailbox answers again; one message was deleted meanwhile.
    gmail.refuseMessages = null;
    const gone = owed[0].pid!;
    gmail.messages = gmail.messages.filter((m) => m.id !== gone);
    // Run as the nightly check; a ten-minute round would repeat the last.
    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "owed-night-1" });
    await drainThroughWaits(3);
    expect(await stored(office.orgId)).toBe(59);
    const left = await failedRows(office.orgId);
    expect(left).toHaveLength(1);
    expect(left[0].pid).toBe(gone);
    expect(left[0].reason).toBe("This message was no longer in the mailbox when it was asked for.");

    const requests = gmail.requests.length;
    await tenMinutesLater(office.orgId);
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "owed-round-2" });
    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "owed-night-2" });
    await drainThroughWaits(2);
    expect(gmail.requests.slice(requests).some((r) => r.endsWith(`/messages/${gone}`))).toBe(false);
    const subjects = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ s: emailMessages.subject }).from(emailMessages).where(eq(emailMessages.organizationId, office.orgId)));
    expect(new Set(subjects.map((r) => r.s)).size).toBe(59);
  });

  it("stops the ten-minute rounds after their tries and leaves the rest to the nightly check", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.night@house.example.gov");
    fill(gmail, 5);
    gmail.refuseMessages = { status: 500 };
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainThroughWaits();
    expect(await failedRows(office.orgId)).toHaveLength(5);

    gmail.refuseMessages = null;
    const db = await systemDb();
    await db.update(mailLedger).set({ attempts: 12 }).where(eq(mailLedger.organizationId, office.orgId));
    await tenMinutesLater(office.orgId);
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "night-round" });
    await drainThroughWaits(2);
    expect(await stored(office.orgId)).toBe(0);

    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "night-check" });
    await drainThroughWaits(2);
    expect(await stored(office.orgId)).toBe(5);
    expect(await failedRows(office.orgId)).toHaveLength(0);
  });

  it("works through a large mailbox at the pace the mailbox allows, without using up any message's tries", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.pace@house.example.gov");
    fill(gmail, 60);
    const limit = { status: 403, reason: "rateLimitExceeded" };
    gmail.refuseMessages = { ...limit, afterGets: 10 };
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainThroughWaits();
    expect(await stored(office.orgId)).toBe(10);
    const owed = await failedRows(office.orgId);
    expect(owed).toHaveLength(50);
    expect(owed.every((r) => r.attempts === 1 && r.reason?.startsWith("The mailbox stopped answering"))).toBe(true);
    expect((await syncState(office.orgId, conn.id)).backfillStatus).toBe("completed");

    await tenMinutesLater(office.orgId);
    gmail.refuseMessages = { ...limit, afterGets: 30 };
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "pace-round-1" });
    await drainJobs();
    expect(await stored(office.orgId)).toBe(40);
    const db = await systemDb();
    const waiting = await db.select({ runAt: backgroundJobs.runAt }).from(backgroundJobs)
      .where(and(eq(backgroundJobs.organizationId, office.orgId), eq(backgroundJobs.name, "mail.fetch_batch"), eq(backgroundJobs.status, "queued")));
    expect(waiting.length).toBeGreaterThan(0);
    for (const w of waiting) expect(w.runAt.getTime()).toBeGreaterThan(Date.now() + 55_000);
    gmail.refuseMessages = { ...limit, afterGets: 12 };
    await endWaits();
    await drainJobs();
    expect(await stored(office.orgId)).toBe(52);
    gmail.refuseMessages = null;
    await endWaits();
    await drainJobs();
    expect(await stored(office.orgId)).toBe(60);
    expect(await failedRows(office.orgId)).toHaveLength(0);
    expect(await db.select({ id: backgroundJobs.id }).from(backgroundJobs)
      .where(and(eq(backgroundJobs.organizationId, office.orgId), eq(backgroundJobs.status, "dead")))).toHaveLength(0);
    const tries = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ attempts: mailLedger.attempts }).from(mailLedger).where(eq(mailLedger.organizationId, office.orgId)));
    expect(Math.max(...tries.map((t) => t.attempts))).toBeLessThanOrEqual(2);
  });

  it("treats Google's 403 rate limit as a wait, and keeps the reason Google gives for any other refusal", async () => {
    const body = (reason: string) => new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED",
      message: "A sentence that could name a mailbox.", errors: [{ domain: "usageLimits", reason }] } }), { status: 403 });
    await expect(checked(body("rateLimitExceeded"), "Gmail get")).rejects.toBeInstanceOf(RetryLaterError);
    await expect(checked(body("userRateLimitExceeded"), "Gmail get")).rejects.toBeInstanceOf(RetryLaterError);
    const details = new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }] } }), { status: 403 });
    await expect(checked(details, "Gmail get")).rejects.toBeInstanceOf(RetryLaterError);

    const other = await checked(body("insufficientPermissions"), "Gmail get").catch((e) => e);
    expect(other).toBeInstanceOf(ProviderHttpError);
    expect(other.reason).toBe("insufficientPermissions");
    expect(other.message).toBe("Gmail get failed (403 PERMISSION_DENIED insufficientPermissions)");
    // Only a code word is kept, never a sentence.
    const wordy = await checked(body("The mailbox of jane@example.org is over quota"), "Gmail get").catch((e) => e);
    expect(wordy.reason).toBeNull();

    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.limit@house.example.gov");
    fill(gmail, 4);
    gmail.refuseMessages = { status: 403, reason: "rateLimitExceeded" };
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    const db = await systemDb();
    const [job] = await db.select().from(backgroundJobs)
      .where(and(eq(backgroundJobs.name, "mail.fetch_batch"), eq(backgroundJobs.organizationId, office.orgId)));
    expect(job.status).toBe("queued");
    // Google names no wait, so the job waits a little over a minute.
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect(await failedRows(office.orgId)).toHaveLength(0);
    const waits = await withTenant({ orgId: office.orgId }, (tx) => tx.select({ message: integrationErrors.message }).from(integrationErrors)
      .where(and(eq(integrationErrors.organizationId, office.orgId), eq(integrationErrors.operation, "rate_limit"))));
    expect(waits.map((w) => w.message)).toEqual(["Gmail get: provider rate limit (403 rateLimitExceeded)"]);
    gmail.refuseMessages = { status: 403, reason: "insufficientPermissions", afterGets: 1 };
    await drainThroughWaits();
    expect(await stored(office.orgId)).toBe(1);
    const errors = await withTenant({ orgId: office.orgId }, (tx) => tx.select({ message: integrationErrors.message }).from(integrationErrors)
      .where(and(eq(integrationErrors.organizationId, office.orgId), eq(integrationErrors.operation, "fetch_message"))));
    expect(errors.map((e) => e.message)).toContain("Could not fetch a message (403 insufficientPermissions).");
  });
});
