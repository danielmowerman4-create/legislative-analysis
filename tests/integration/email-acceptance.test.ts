import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { freshDatabase, makeOffice as newOffice, contextFor } from "../helpers/db";
import { enableConstituentCenter } from "@/server/services/center";
import { connectFakeGmail, syncState } from "../helpers/mailbox";
import { withTenant } from "@/server/db/client";
import { contactEmails, contacts, emailMessages, messageIssueLinks, backgroundJobs, contactNotes, cases } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { processGmailPush } from "@/server/email/webhooks";
import { listInbox, getMessageDetail } from "@/server/services/inbox";
import { setIssueLabel } from "@/server/services/corrections";
import { classifyMessage } from "@/server/services/classify";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { addMember } from "@/server/services/offices";
import { systemDb } from "@/server/db/client";

afterAll(() => setProviderFetchForTests(null));

// Constituent Center brings the office's issue list and agencies.
async function makeOffice(...args: Parameters<typeof newOffice>) {
  const office = await newOffice(...args);
  await enableConstituentCenter(office.orgId);
  return office;
}

describe("email acceptance", () => {
  beforeAll(async () => {
    await freshDatabase();
  });

  it("Test A: a pushed Gmail message is stored once, summarized, classified and visible in the inbox", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId);
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    const state = await syncState(office.orgId, conn.id);
    expect(state.cursor).toBe(String(gmail.historyId));

    gmail.add({ from: "maria.lopez@gmail.com", fromName: "Maria Lopez", subject: "Teacher pay", body: "Dear Rep. Test,\n\nI strongly support raising teacher pay this session. Our teachers are leaving for neighboring districts.\n\nMaria Lopez\nDecatur" });
    const push = gmail.pushBody("pubsub-1");
    expect((await processGmailPush(push)).outcome).toBe("enqueued");
    const [{ n: beforeSync }] = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ n: count() }).from(emailMessages).where(eq(emailMessages.organizationId, office.orgId)));
    expect(beforeSync).toBe(0);

    await drainJobs();
    const inbox = await listInbox(office.ctx, { folder: "all" });
    expect(inbox.items).toHaveLength(1);
    const item = inbox.items[0];
    expect(item.subject).toBe("Teacher pay");
    expect(item.summary).toBeTruthy();
    expect(item.issues.map((i) => i.key)).toContain("education.teacher_pay");
    const detail = await getMessageDetail(office.ctx, item.id);
    expect(detail.message.processingStatus).toBe("processed");
    expect(detail.positions.find((p) => p.targetKey === "issue:education.teacher_pay")?.position).toBe("support");
    expect(detail.contact?.fullName).toBe("Maria Lopez");
  });

  it("Test K: duplicate push delivery and an expired history cursor neither lose nor duplicate mail", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.k@house.example.gov");
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();

    gmail.add({ from: "a@gmail.com", subject: "Roads", body: "The potholes on Main Street are dangerous. Please fix them." });
    const body = gmail.pushBody("pubsub-dup");
    expect((await processGmailPush(body)).outcome).toBe("enqueued");
    expect((await processGmailPush(body)).outcome).toBe("duplicate"); // same Pub/Sub delivery redelivered
    await drainJobs();

    gmail.add({ from: "b@gmail.com", subject: "Transit", body: "Please expand bus service to our neighborhood." });
    gmail.add({ from: "c@gmail.com", subject: "Medicaid", body: "I support Medicaid expansion." });
    gmail.expireHistoryBefore(gmail.historyId + 1);
    await enqueue("mail.incremental", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "k-recover" });
    await drainJobs();

    const rows = await withTenant({ orgId: office.orgId }, (tx) => tx.select({ subject: emailMessages.subject, pid: emailMessages.providerMessageId })
      .from(emailMessages).where(eq(emailMessages.organizationId, office.orgId)));
    expect(rows.map((r) => r.subject).sort()).toEqual(["Medicaid", "Roads", "Transit"]);
    expect(new Set(rows.map((r) => r.pid)).size).toBe(3);
    const state = await syncState(office.orgId, conn.id);
    expect(state.lastCursorResetAt).not.toBeNull();
    expect(state.cursor).toBe(String(gmail.historyId));

    await processGmailPush(gmail.pushBody("pubsub-late"));
    await enqueue("mail.reconcile", { connectionId: conn.id }, { orgId: office.orgId, idempotencyKey: "k-reconcile" });
    await drainJobs();
    const [{ n }] = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ n: count() }).from(emailMessages).where(eq(emailMessages.organizationId, office.orgId)));
    expect(n).toBe(3);
  });

  it("retries provider rate limits with backoff instead of failing", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.rl@house.example.gov");
    gmail.failNextWith = 429;
    const jobId = await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    const db = await systemDb();
    const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, jobId!));
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("Test D: a staff correction to an issue label survives reprocessing", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.d@house.example.gov");
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    gmail.add({ from: "d@gmail.com", subject: "Bus", body: "The school bus route on Elm Road skips our street. Please look into it." });
    await processGmailPush(gmail.pushBody("pubsub-d"));
    await drainJobs();
    const [msg] = (await listInbox(office.ctx, { folder: "all" })).items;
    expect(msg.issues.map((i) => i.key)).toContain("education.transportation");

    await setIssueLabel(office.ctx, msg.id, "education.transportation", "reject");
    await setIssueLabel(office.ctx, msg.id, "transportation.public_transit", "confirm");
    await classifyMessage(office.orgId, msg.id); // reprocess with the same rules that produced the wrong label

    const links = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(messageIssueLinks).where(eq(messageIssueLinks.messageId, msg.id)));
    const wrong = links.find((l) => l.issueKey === "education.transportation")!;
    const added = links.find((l) => l.issueKey === "transportation.public_transit")!;
    expect(wrong.status).toBe("rejected");
    expect(wrong.source).toBe("staff");
    expect(added.status).toBe("confirmed");
    expect(links.filter((l) => l.issueKey === "education.transportation")).toHaveLength(1);
  });

  it("Test F: a returning constituent's new message joins their existing record", async () => {
    const office = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(office.orgId, office.ownerId, "rep.f@house.example.gov");
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: office.orgId });
    await drainJobs();
    gmail.add({ from: "james.w@yahoo.com", fromName: "James Walker", subject: "Property taxes", body: "My property tax assessment went up 40% this year." });
    await processGmailPush(gmail.pushBody("f1"));
    await drainJobs();
    gmail.add({ from: "James.W@yahoo.com", fromName: "James Walker", subject: "Following up",
      body: "Following up on my property tax question from last month." });
    await processGmailPush(gmail.pushBody("f2"));
    await drainJobs();

    const people = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(contacts).where(eq(contacts.organizationId, office.orgId)));
    expect(people).toHaveLength(1);
    const emails = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(contactEmails).where(eq(contactEmails.contactId, people[0].id)));
    expect(emails).toHaveLength(1);
    expect(emails[0].verified).toBe(true);
    const msgs = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ contactId: emailMessages.contactId }).from(emailMessages).where(eq(emailMessages.organizationId, office.orgId)));
    expect(msgs.every((m) => m.contactId === people[0].id)).toBe(true);

    gmail.add({ from: "jwalker@outlook.com", fromName: "James Walker", subject: "Hi", body: "Another note about property taxes." });
    await processGmailPush(gmail.pushBody("f3"));
    await drainJobs();
    const after = await withTenant({ orgId: office.orgId },
      (tx) => tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.organizationId, office.orgId)));
    expect(after).toHaveLength(2);
  });

  it("Test J: staff in one office cannot retrieve another office's emails, contacts, cases or private notes", async () => {
    const a = await makeOffice();
    const b = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(a.orgId, a.ownerId, "rep.j@house.example.gov");
    await enqueue("mail.backfill", { connectionId: conn.id }, { orgId: a.orgId });
    await drainJobs();
    gmail.add({ from: "secret@gmail.com", fromName: "Private Person", subject: "Confidential", body: "I need help with my Medicaid application." });
    await processGmailPush(gmail.pushBody("j1"));
    await drainJobs();
    const [aMsg] = (await listInbox(a.ctx, { folder: "all" })).items;
    const [aContact] = await withTenant({ orgId: a.orgId }, (tx) => tx.select().from(contacts).where(eq(contacts.organizationId, a.orgId)));
    await withTenant({ orgId: a.orgId, userId: a.ownerId },
      (tx) => tx.insert(contactNotes).values({ organizationId: a.orgId, contactId: aContact.id, authorId: a.ownerId, body: "private", visibility: "private" }));
    await withTenant({ orgId: a.orgId },
      (tx) => tx.insert(cases).values({ organizationId: a.orgId, caseNumber: "C-1", title: "Medicaid", category: "Medicaid" }));

    const bStaff = await addMember(b.ctx, { email: `aide-j-${b.orgId}@example.test`, name: "B Aide", roleKey: "caseworker" });
    const bCtx = await contextFor(bStaff, b.orgId);
    expect((await listInbox(bCtx, { folder: "all" })).items).toHaveLength(0);
    await expect(getMessageDetail(bCtx, aMsg.id)).rejects.toThrow(/not found/i);

    // Even a forged context for B's user cannot see A's rows through RLS.
    const leaked = await withTenant({ orgId: b.orgId, userId: bStaff }, async (tx) => ({
      messages: await tx.select().from(emailMessages).where(eq(emailMessages.id, aMsg.id)),
      contacts: await tx.select().from(contacts).where(eq(contacts.id, aContact.id)),
      notes: await tx.select().from(contactNotes).where(eq(contactNotes.contactId, aContact.id)),
      cases: await tx.select().from(cases).where(and(eq(cases.organizationId, a.orgId))),
    }));
    expect(leaked).toEqual({ messages: [], contacts: [], notes: [], cases: [] });
  });
});
