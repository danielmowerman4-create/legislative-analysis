import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import PostalMime from "postal-mime";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { FakeGmail } from "../helpers/fake-gmail";
import { FakeImap } from "../helpers/fake-imap";
import { startFakeSmtp } from "../helpers/fake-smtp";
import { connectFakeGmail } from "../helpers/mailbox";
import { closeDb, systemDb, withTenant } from "@/server/db/client";
import { backgroundJobs, contactEmails, emailConnections, emailDrafts, emailMessages, emailSyncState, mailLedger, mailReconciliations, messageEvents,
  officeSettings, replyDeliveries } from "@/server/db/schema";
import type { OfficeContext } from "@/server/authz/context";
import { configureMailbox, completeMailboxConnection, connectPasswordMailbox, disconnectMailbox, listMailboxFolders,
  startMailboxConnection } from "@/server/email/connections";
import type { NormalizedMessage } from "@/server/email/normalize";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { setImapOpenerForTests } from "@/server/email/providers/imap";
import { buildReplyMime } from "@/server/email/send";
import { proveSending, turnOffSending, turnOnSending } from "@/server/email/sending";
import { resetEnvForTests } from "@/server/env";
import { enqueue } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { composeLink } from "@/lib/compose";
import { checkMailNow, setReplySignature, setupStatus } from "@/server/services/center";
import { ingestMessage } from "@/server/services/ingest";
import { addMember } from "@/server/services/offices";
import { approveReplyDraft, createReplyDraft, deliverReply, listSentReplies, replyRoutes, sendReplyDraft, updateReplyDraft } from "@/server/services/replies";

const REP = "rep@gmail.com";
const APP_PASSWORD = "abcd efgh ijkl mnop";
const LETTER = { from: "Ann Lee <ann@mail.test>", subject: "Potholes on Elm Street", body: "Please fix the potholes on Elm Street. They are ruining my car.",
  id: "ann-1@mail.test" };
const ANSWER = "Dear Ann,\n\nWe have asked the county to repair Elm Street this month.\n\nSincerely,\nRep. Test";

let polls = 0;
const jobs = () => drainJobs(["mail", "classify"]);
const poll = async (orgId: string, connectionId: string) => {
  await enqueue("mail.incremental", { connectionId }, { orgId, idempotencyKey: `test-poll:${connectionId}:${++polls}` });
  await jobs();
};
const mailboxes = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(emailConnections).where(eq(emailConnections.organizationId, orgId)));
const mailbox = async (orgId: string, id: string) => (await mailboxes(orgId)).find((m) => m.id === id)!;
const stored = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.organizationId, orgId)));
const letterBy = async (orgId: string, from: string) => (await stored(orgId)).find((m) => m.direction === "inbound" && m.fromAddress === from)!;
const draftOf = async (orgId: string, id: string) => (await withTenant({ orgId }, (tx) => tx.select().from(emailDrafts).where(eq(emailDrafts.id, id))))[0];
const deliveriesOf = (orgId: string, draftId: string) =>
  withTenant({ orgId }, (tx) => tx.select().from(replyDeliveries).where(eq(replyDeliveries.draftId, draftId)));
const repliesTo = (orgId: string, messageId: string) =>
  withTenant({ orgId }, (tx) => tx.select().from(messageEvents).where(and(eq(messageEvents.messageId, messageId), eq(messageEvents.type, "reply_sent"))));
const staff = async (o: { ctx: OfficeContext; orgId: string }, name: string, roleKey: "legislative_aide" | "caseworker" | "chief_of_staff" | "viewer") => {
  const userId = await addMember(o.ctx, { email: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}@staff.test`, name, roleKey, title: roleKey });
  return { userId, ctx: await contextFor(userId, o.orgId) };
};

async function link(ctx: OfficeContext, box: FakeImap, opts: { watchSent?: boolean; password?: string } = {}) {
  setImapOpenerForTests(box.open);
  const r = await connectPasswordMailbox(ctx, { email: box.address, password: opts.password ?? APP_PASSWORD, acknowledged: true });
  const folders = await listMailboxFolders(ctx, r.id);
  const sent = folders.find((f) => f.isSent)!;
  await configureMailbox(ctx, r.id,
    { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01", sentFolder: opts.watchSent === false ? null : { id: sent.id, name: sent.name } });
  await jobs();
  return r.id;
}

async function approvedReply(o: { ctx: OfficeContext; orgId: string }, box: FakeImap, connectionId: string, letter = LETTER, text = ANSWER) {
  box.add("INBOX", letter);
  await poll(o.orgId, connectionId);
  const m = await letterBy(o.orgId, letter.from.match(/<(.+)>/)![1]);
  const draft = await createReplyDraft(o.ctx, m.id);
  await updateReplyDraft(o.ctx, draft.id, text);
  await approveReplyDraft(o.ctx, draft.id);
  return { letter: m, draftId: draft.id };
}

let smtp: Awaited<ReturnType<typeof startFakeSmtp>> | null = null;

beforeAll(async () => {
  await freshDatabase();
});
afterAll(() => closeDb());
afterEach(async () => {
  setImapOpenerForTests(null);
  setProviderFetchForTests(null);
  await smtp?.close();
  smtp = null;
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  resetEnvForTests();
});

describe("each person links their own email", () => {
  it("lets an aide link their mailbox, and only they or a manager can change it", async () => {
    const o = await makeOffice();
    const amy = await staff(o, "Amy", "legislative_aide");
    const bo = await staff(o, "Bo", "caseworker");
    const id = await link(amy.ctx, new FakeImap("amy.aide@gmail.com"));
    expect(await mailbox(o.orgId, id)).toMatchObject({ emailAddress: "amy.aide@gmail.com", authorizedBy: amy.userId, status: "active", sendEnabledAt: null });

    await expect(listMailboxFolders(bo.ctx, id)).rejects.toThrow(/permission/);
    await expect(configureMailbox(bo.ctx, id, { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01" })).rejects.toThrow(/permission/);
    await expect(turnOnSending(bo.ctx, id, true)).rejects.toThrow(/permission/);
    await expect(disconnectMailbox(bo.ctx, id)).rejects.toThrow(/permission/);

    const seenByBo = (await setupStatus(bo.ctx)).mailboxes.find((m) => m.id === id)!;
    expect(seenByBo).toMatchObject({ linkedBy: "Amy", mine: false, canManage: false });
    expect((await setupStatus(amy.ctx)).mailboxes.find((m) => m.id === id)).toMatchObject({ mine: true, canManage: true });
    expect((await setupStatus(o.ctx)).mailboxes.find((m) => m.id === id)).toMatchObject({ mine: false, canManage: true });

    await disconnectMailbox(o.ctx, id);
    expect(await mailbox(o.orgId, id)).toMatchObject({ status: "disconnected", refreshTokenEnc: null });
  });

  it("holds several people's mailboxes in one office, each read on its own", async () => {
    const o = await makeOffice();
    const amy = await staff(o, "Amy", "legislative_aide");
    const repBox = new FakeImap(REP);
    const amyBox = new FakeImap("amy.aide@yahoo.com");
    repBox.add("INBOX", LETTER);
    amyBox.add("INBOX",
      { from: "Ben Ray <ben@mail.test>", subject: "Bus route 9", body: "Please keep bus route 9 running on weekends.", id: "ben-1@mail.test" });
    // The fake serves one login at a time, so each box is read before the next.
    const repId = await link(o.ctx, repBox);
    const amyId = await link(amy.ctx, amyBox, { password: "abcdefghijklmnop" });
    const all = await stored(o.orgId);
    expect(all.find((m) => m.fromAddress === "ann@mail.test")?.connectionId).toBe(repId);
    expect(all.find((m) => m.fromAddress === "ben@mail.test")?.connectionId).toBe(amyId);
    expect((await mailboxes(o.orgId)).map((m) => m.authorizedBy).sort()).toEqual([o.ownerId, amy.userId].sort());
  });

  it("reads again under a new password without asking for folders again, and sending waits to be turned on again", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    smtp = await startFakeSmtp({ password: "abcdefghijklmnop" });
    await turnOnSending(o.ctx, id, true);
    expect((await mailbox(o.orgId, id)).sendEnabledAt).not.toBeNull();
    await connectPasswordMailbox(o.ctx, { email: REP, password: APP_PASSWORD, acknowledged: true });
    expect(await mailbox(o.orgId, id)).toMatchObject({ status: "active", sendEnabledAt: null, selectedFolders: [{ id: "INBOX", name: "INBOX" }] });
  });

  it("watches Sent or reads it in full, never both, and stops reading folders that are dropped", async () => {
    const o = await makeOffice();
    const id = await link(o.ctx, new FakeImap(REP));
    const states = async () => (await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailSyncState).where(eq(emailSyncState.connectionId, id))))
      .map((s) => `${s.folderId}:${s.purpose}`).sort();
    expect(await states()).toEqual(["INBOX:mail", "Sent:sent"]);
    expect((await mailbox(o.orgId, id)).sentFolder).toEqual({ id: "Sent", name: "Sent" });

    await configureMailbox(o.ctx, id,
      { folders: [{ id: "INBOX", name: "INBOX" }, { id: "Sent", name: "Sent" }], importFrom: "2026-01-01", sentFolder: { id: "Sent", name: "Sent" } });
    expect(await states()).toEqual(["INBOX:mail", "Sent:mail"]);
    expect((await mailbox(o.orgId, id)).sentFolder).toBeNull();

    await configureMailbox(o.ctx, id, { folders: [{ id: "Constituents", name: "Constituents" }], importFrom: "2026-01-01", sentFolder: null });
    expect(await states()).toEqual(["Constituents:mail"]);
  });
});

describe("sending from the linked mailbox", () => {
  it("stays off until the person turns it on, and proves it with a message to the mailbox itself", async () => {
    const o = await makeOffice();
    const id = await link(o.ctx, new FakeImap(REP));
    smtp = await startFakeSmtp({ user: REP, password: "abcdefghijklmnop" });
    await expect(turnOnSending(o.ctx, id, false)).rejects.toThrow(/Confirm/);
    expect(smtp.delivered).toHaveLength(0);

    expect(await turnOnSending(o.ctx, id, true)).toEqual({ url: null });
    expect(smtp.delivered).toHaveLength(1);
    expect(smtp.delivered[0]).toMatchObject({ from: REP, to: [REP], user: REP });
    const test = await PostalMime.parse(smtp.delivered[0].raw);
    expect(test.subject).toBe("Constituent Center can send from this mailbox");
    expect(test.text).toContain("only after a person approves it and presses Send");
    expect(await mailbox(o.orgId, id)).toMatchObject({ sendEnabledBy: o.ownerId });

    await turnOffSending(o.ctx, id);
    expect((await mailbox(o.orgId, id)).sendEnabledAt).toBeNull();
  });

  it("leaves sending off when the mail service refuses the test", async () => {
    const o = await makeOffice();
    const id = await link(o.ctx, new FakeImap(REP));
    smtp = await startFakeSmtp({ password: "a different password" });
    await expect(turnOnSending(o.ctx, id, true)).rejects.toThrow(/Sending was not turned on\. The mailbox refused/);
    expect((await mailbox(o.orgId, id)).sendEnabledAt).toBeNull();
  });

  it("sends an approved reply as an answer to the person's own letter, once", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    smtp = await startFakeSmtp({ user: REP, password: "abcdefghijklmnop" });
    const { letter, draftId } = await approvedReply(o, box, id);

    await expect(sendReplyDraft(o.ctx, draftId)).rejects.toThrow(/Sending is not turned on for rep@gmail\.com/);
    expect(smtp.delivered).toHaveLength(0);
    expect((await draftOf(o.orgId, draftId)).status).toBe("approved");
    expect((await replyRoutes(o.ctx, [{ id: draftId, connectionId: id }])).get(draftId)).toMatchObject({ from: REP, opensIn: "gmail", canSend: false });

    await turnOnSending(o.ctx, id, true);
    expect((await replyRoutes(o.ctx, [{ id: draftId, connectionId: id }])).get(draftId)).toMatchObject({ canSend: true });
    expect(await sendReplyDraft(o.ctx, draftId)).toEqual({ sent: 1, queued: 0 });

    expect(smtp.delivered).toHaveLength(2);
    const out = smtp.delivered[1];
    expect(out).toMatchObject({ from: REP, to: ["ann@mail.test"] });
    const mail = await PostalMime.parse(out.raw);
    expect(mail.subject).toBe("Re: Potholes on Elm Street");
    expect(mail.from).toMatchObject({ address: REP, name: "Rep. Test" });
    expect(mail.to?.[0]).toMatchObject({ address: "ann@mail.test" });
    expect(mail.inReplyTo).toBe("<ann-1@mail.test>");
    expect(mail.references).toContain("<ann-1@mail.test>");
    expect(mail.text?.trim()).toBe(ANSWER);

    expect(await draftOf(o.orgId, draftId)).toMatchObject({ status: "sent", sentVia: "app", sentBy: o.ownerId });
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
    expect(await repliesTo(o.orgId, letter.id)).toHaveLength(1);
    expect((await listSentReplies(o.ctx))[0]).toMatchObject({ id: draftId, sentVia: "app" });

    await expect(sendReplyDraft(o.ctx, draftId)).rejects.toThrow(/approved before it is sent/);
    expect(smtp.delivered).toHaveLength(2);

    // The mail service files its copy in Sent; reading it back adds nothing.
    box.fileSent(out.raw);
    await poll(o.orgId, id);
    expect((await stored(o.orgId)).filter((m) => m.direction === "outbound")).toHaveLength(1);
    expect(await repliesTo(o.orgId, letter.id)).toHaveLength(1);
  });

  it("only sends for whoever approves replies or linked the mailbox, and never an unapproved reply", async () => {
    const o = await makeOffice();
    const amy = await staff(o, "Amy", "legislative_aide");
    const bo = await staff(o, "Bo", "caseworker");
    const box = new FakeImap("amy.aide@gmail.com");
    const id = await link(amy.ctx, box);
    smtp = await startFakeSmtp({ password: "abcdefghijklmnop" });
    await turnOnSending(amy.ctx, id, true);

    box.add("INBOX", LETTER);
    await poll(o.orgId, id);
    const m = await letterBy(o.orgId, "ann@mail.test");
    const draft = await createReplyDraft(amy.ctx, m.id);
    await updateReplyDraft(amy.ctx, draft.id, ANSWER);
    await expect(sendReplyDraft(amy.ctx, draft.id)).rejects.toThrow(/approved before it is sent/);
    await expect(approveReplyDraft(amy.ctx, draft.id)).rejects.toThrow(/permission/);
    await approveReplyDraft(o.ctx, draft.id);

    await expect(sendReplyDraft(bo.ctx, draft.id)).rejects.toThrow(/whoever approves replies, or the person who linked the mailbox/);
    expect(smtp.delivered).toHaveLength(1);
    expect((await replyRoutes(bo.ctx, [{ id: draft.id, connectionId: id }])).get(draft.id)?.canSend).toBe(false);

    await sendReplyDraft(amy.ctx, draft.id);
    expect(smtp.delivered[1]).toMatchObject({ from: "amy.aide@gmail.com", to: ["ann@mail.test"] });
    expect(await draftOf(o.orgId, draft.id)).toMatchObject({ status: "sent", sentBy: amy.userId, approvedBy: o.ownerId });
  });

  it("says why a reply did not go, keeps it approved, and does not send a second copy on the next try", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    smtp = await startFakeSmtp({ password: "abcdefghijklmnop" });
    await turnOnSending(o.ctx, id, true);
    const { draftId } = await approvedReply(o, box, id);

    smtp.state.rejectNext = "Mailbox unavailable";
    await expect(sendReplyDraft(o.ctx, draftId)).rejects.toThrow(/would not take it \(550\)/);
    expect((await draftOf(o.orgId, draftId)).status).toBe("approved");
    expect(await deliveriesOf(o.orgId, draftId)).toMatchObject([{ status: "failed", toAddress: "ann@mail.test" }]);
    expect((await replyRoutes(o.ctx, [{ id: draftId, connectionId: id }])).get(draftId)?.problems[0])
      .toMatch(/ann@mail\.test: The mail service would not take it/);
    expect(smtp.delivered.filter((d) => d.to[0] === "ann@mail.test")).toHaveLength(0);

    await sendReplyDraft(o.ctx, draftId);
    expect(smtp.delivered.filter((d) => d.to[0] === "ann@mail.test")).toHaveLength(1);
    expect(await deliveriesOf(o.orgId, draftId)).toMatchObject([{ status: "sent", attempts: 2 }]);
    expect((await draftOf(o.orgId, draftId)).status).toBe("sent");
  });

  it("never resends a copy that may already have gone out, and settles it when the copy turns up in Sent", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    smtp = await startFakeSmtp({ password: "abcdefghijklmnop" });
    await turnOnSending(o.ctx, id, true);
    const { letter, draftId } = await approvedReply(o, box, id);
    // A crash after the hand-off, before the delivery was recorded.
    const [stuck] = await withTenant({ orgId: o.orgId }, async (tx) => {
      await tx.update(emailDrafts).set({ status: "sending" }).where(eq(emailDrafts.id, draftId));
      return tx.insert(replyDeliveries).values({ organizationId: o.orgId, draftId, messageId: letter.id, connectionId: id, toAddress: "ann@mail.test",
        status: "sending", attempts: 1, rfcMessageId: "stuck-1@gmail.com" }).returning();
    });
    await expect(deliverReply(o.orgId, stuck.id)).rejects.toThrow(/may already have gone out/);
    expect(smtp.delivered.filter((d) => d.to[0] === "ann@mail.test")).toHaveLength(0);
    expect((await draftOf(o.orgId, draftId)).status).toBe("approved");

    box.add("Sent",
      { from: `Rep. Test <${REP}>`, to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: ANSWER, id: "stuck-1@gmail.com", inReplyTo: LETTER.id });
    await poll(o.orgId, id);
    expect(await deliveriesOf(o.orgId, draftId)).toMatchObject([{ status: "sent" }]);
    expect(await draftOf(o.orgId, draftId)).toMatchObject({ status: "sent", sentVia: "app" });
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
    expect(await repliesTo(o.orgId, letter.id)).toHaveLength(1);
  });

  it("gives each person their own copy when one answer goes to several, and nobody sees the others", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    smtp = await startFakeSmtp({ password: "abcdefghijklmnop" });
    await turnOnSending(o.ctx, id, true);
    box.add("INBOX",
      { from: "Ann Lee <ann@mail.test>", subject: "Vote yes on HB 142", body: "Please vote yes on HB 142, the school lunch bill.", id: "ann-142@mail.test" });
    box.add("INBOX",
      { from: "Ben Ray <ben@mail.test>", subject: "Support HB 142", body: "I am writing to support HB 142 for school lunches.", id: "ben-142@mail.test" });
    await poll(o.orgId, id);
    const ann = await letterBy(o.orgId, "ann@mail.test");
    const ben = await letterBy(o.orgId, "ben@mail.test");
    const [draft] = await withTenant({ orgId: o.orgId }, (tx) =>
      tx
        .insert(emailDrafts)
        .values({ organizationId: o.orgId, authorId: o.ownerId, toAddresses: ["ann@mail.test", "ben@mail.test"], subject: "HB 142: School lunches",
          bodyText: "Thank you for writing about HB 142. It passed the House on Tuesday.", status: "approved", approvedBy: o.ownerId, approvedAt: new Date(),
          citations: [{ type: "message", id: ann.id, label: "Ann Lee" }, { type: "message", id: ben.id, label: "Ben Ray" }] })
        .returning(),
    );
    expect(await sendReplyDraft(o.ctx, draft.id)).toEqual({ sent: 0, queued: 2 });
    expect((await draftOf(o.orgId, draft.id)).status).toBe("sending");
    await jobs();

    const copies = smtp.delivered.slice(1);
    expect(copies.map((c) => c.to).sort()).toEqual([["ann@mail.test"], ["ben@mail.test"]]);
    for (const c of copies) {
      const mail = await PostalMime.parse(c.raw);
      expect(mail.to).toHaveLength(1);
      expect(mail.cc ?? []).toHaveLength(0);
      expect(c.raw).not.toContain(c.to[0] === "ann@mail.test" ? "ben@mail.test" : "ann@mail.test");
      expect(mail.inReplyTo).toBe(c.to[0] === "ann@mail.test" ? "<ann-142@mail.test>" : "<ben-142@mail.test>");
    }
    expect(await draftOf(o.orgId, draft.id)).toMatchObject({ status: "sent", sentVia: "app" });
    expect((await stored(o.orgId)).filter((m) => m.direction === "inbound").map((m) => m.triageStatus)).toEqual(["done", "done"]);
  });
});

describe("letters answered from the person's own mail", () => {
  it("marks a letter answered when the reply appears in Sent, and reads nothing else in Sent", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    const { letter, draftId } = await approvedReply(o, box, id);

    box.add("Sent", { from: REP, to: "friend@elsewhere.test", subject: "Dinner on Friday", body: "Private plans.", id: "dinner@gmail.com" });
    box.add("Sent", { from: REP, to: "clerk@county.test", subject: "Fw: Potholes on Elm Street", body: "Can your crew look at this?", id: "forward@gmail.com",
      inReplyTo: LETTER.id });
    box.add("Sent", { from: REP, to: "ann@mail.test", subject: "Re: A different matter", body: "About something else.", id: "other@gmail.com" });
    box.add("Sent", { from: REP, to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: ANSWER, id: "reply@gmail.com", inReplyTo: LETTER.id });
    await poll(o.orgId, id);

    const out = (await stored(o.orgId)).filter((m) => m.direction === "outbound");
    expect(out.map((m) => m.rfcMessageId)).toEqual(["reply@gmail.com"]);
    expect(box.read.filter((r) => r.startsWith("Sent:"))).toEqual(["Sent:reply@gmail.com"]);
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
    expect(await repliesTo(o.orgId, letter.id)).toMatchObject([{ data: { via: "mailbox", outboundMessageId: out[0].id } }]);
    expect(await draftOf(o.orgId, draftId)).toMatchObject({ status: "sent", sentVia: "mailbox" });
    expect(out[0].threadId).toBe(letter.threadId);

    const known = await withTenant({ orgId: o.orgId },
      (tx) => tx.select({ email: contactEmails.email }).from(contactEmails).where(eq(contactEmails.organizationId, o.orgId)));
    expect(known.map((k) => k.email)).toEqual(["ann@mail.test"]);
    const ledger = await withTenant({ orgId: o.orgId },
      (tx) => tx.select({ subject: mailLedger.subject }).from(mailLedger).where(eq(mailLedger.organizationId, o.orgId)));
    expect(ledger.map((l) => l.subject).sort()).toEqual(["Potholes on Elm Street", "Re: Potholes on Elm Street"]);
  });

  it("knows a reply written fresh in Outlook or Gmail by its subject and who it went to", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    box.add("INBOX", LETTER);
    await poll(o.orgId, id);
    box.add("Sent", { from: REP, to: "Ann Lee <ann@mail.test>", subject: "RE: Potholes on Elm Street", body: ANSWER, id: "fresh@gmail.com" });
    await poll(o.orgId, id);
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
  });

  it("finds replies sent before the mailbox was linked, once the letters are in", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    box.add("INBOX", LETTER);
    box.add("INBOX", { from: "Ben Ray <ben@mail.test>", subject: "Bus route 9", body: "Please keep bus route 9 running on weekends.", id: "ben-1@mail.test" });
    box.add("Sent", { from: REP, to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: ANSWER, id: "old-reply@gmail.com", inReplyTo: LETTER.id });
    box.add("Sent", { from: REP, to: "friend@elsewhere.test", subject: "Dinner on Friday", body: "Private plans.", id: "dinner@gmail.com" });
    await link(o.ctx, box);
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
    expect((await letterBy(o.orgId, "ben@mail.test")).triageStatus).toBe("new");
    expect(box.read).not.toContain("Sent:dinner@gmail.com");
  });

  it("leaves Sent alone when the person did not ask for it to be watched", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box, { watchSent: false });
    box.add("INBOX", LETTER);
    box.add("Sent", { from: REP, to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: ANSWER, id: "reply@gmail.com", inReplyTo: LETTER.id });
    await poll(o.orgId, id);
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("new");
    expect(box.read.filter((r) => r.startsWith("Sent:"))).toEqual([]);
  });

  it("does not count Sent when checking the mailbox against the record", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    box.add("INBOX", LETTER);
    box.add("Sent", { from: REP, to: "friend@elsewhere.test", subject: "Dinner on Friday", body: "Private plans.", id: "dinner@gmail.com" });
    await poll(o.orgId, id);
    await enqueue("mail.reconcile", { connectionId: id }, { orgId: o.orgId, idempotencyKey: `rec:${id}` });
    await jobs();
    const [check] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(mailReconciliations).where(eq(mailReconciliations.connectionId, id)));
    expect(check).toMatchObject({ mailboxCount: 1, ledgerCount: 1, stillMissing: 0, status: "matched" });
    expect(box.read).not.toContain("Sent:dinner@gmail.com");
  });
});

describe("Gmail and Outlook sign-in", () => {
  const letterFor = (n: number): NormalizedMessage => ({
    providerMessageId: `AAA${n}`,
    providerThreadId: `conv-${n}`,
    rfcMessageId: `cy-${n}@mail.test`,
    inReplyTo: null,
    references: [],
    direction: "inbound",
    labels: ["INBOX"],
    subject: "Library hours",
    from: { address: "cy@mail.test", name: "Cy Dunn" },
    to: [{ address: "rep@house.example.gov", name: null }],
    cc: [],
    replyTo: [],
    sentAt: new Date(),
    receivedAt: new Date(),
    bodyText: "Please keep the library open on Sundays.",
    bodyHtmlSanitized: null,
    headers: { "authentication-results": "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=mail.test; dkim=pass (signature was verified) header.d=mail.test;dmarc=pass action=none header.from=mail.test" },
    rawSizeBytes: 40,
    attachments: [],
  });

  class FakeMicrosoft {
    address = "rep@house.example.gov";
    scope = "openid email User.Read Mail.Read";
    sentMail: string[] = [];
    tokenRequests: URLSearchParams[] = [];
    fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (url.hostname === "login.microsoftonline.com") {
        this.tokenRequests.push(new URLSearchParams(String(init?.body)));
        return json({ access_token: "ms-access", refresh_token: "ms-refresh", expires_in: 3600, scope: this.scope });
      }
      if (url.pathname === "/v1.0/me") return json({ mail: this.address, userPrincipalName: this.address, displayName: "Rep" });
      if (url.pathname === "/v1.0/me/mailFolders/sentitems") return json({ id: "f-sent", displayName: "Gesendete Elemente" });
      if (url.pathname === "/v1.0/me/mailFolders") {
        return json({ value: [{ id: "f-inbox", displayName: "Inbox", totalItemCount: 0 },
          { id: "f-sent", displayName: "Gesendete Elemente", totalItemCount: 0 }] });
      }
      if (url.pathname.endsWith("/messages/delta")) {
        return json({ value: [], "@odata.deltaLink": `https://graph.microsoft.com/v1.0/delta?token=${Math.random()}` });
      }
      if (url.pathname === "/v1.0/delta") return json({ value: [], "@odata.deltaLink": input });
      if (url.pathname.endsWith("/messages")) return json({ value: [] });
      if (url.pathname === "/v1.0/me/sendMail" && init?.method === "POST") {
        if (!/Mail\.Send/.test(this.scope)) return json({ error: { code: "ErrorAccessDenied" } }, 403);
        expect(new Headers(init.headers).get("content-type")).toBe("text/plain");
        this.sentMail.push(Buffer.from(String(init.body), "base64").toString("utf8"));
        return new Response(null, { status: 202 });
      }
      return json({ error: { code: "unhandled", message: url.pathname } }, 404);
    };
  }

  const withMicrosoft = () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    resetEnvForTests();
    const ms = new FakeMicrosoft();
    setProviderFetchForTests(ms.fetch);
    return ms;
  };
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

  it("links Outlook with read access only, for any person who works the mail", async () => {
    const o = await makeOffice();
    const amy = await staff(o, "Amy", "legislative_aide");
    const viewer = await staff(o, "Val", "viewer");
    const ms = withMicrosoft();
    ms.address = "amy@house.example.gov";
    await expect(startMailboxConnection(viewer.ctx, "microsoft", true)).rejects.toThrow(/permission/);
    await expect(startMailboxConnection(amy.ctx, "microsoft", false)).rejects.toThrow(/authorized/);

    const url = new URL(await startMailboxConnection(amy.ctx, "microsoft", true));
    expect(url.searchParams.get("scope")).toBe("offline_access openid email User.Read Mail.Read");
    await expect(completeMailboxConnection("microsoft", "code", url.searchParams.get("state")!, o.ownerId)).rejects.toThrow(/different user/);
    const done = await completeMailboxConnection("microsoft", "code", url.searchParams.get("state")!, amy.userId);
    expect(done.connection)
      .toMatchObject({ provider: "microsoft", emailAddress: "amy@house.example.gov", authorizedBy: amy.userId, status: "pending", sendEnabledAt: null });
    expect(done.sendFor).toBeNull();
    expect(JSON.stringify(done.connection)).not.toContain("ms-refresh");
    expect((await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(officeSettings).where(eq(officeSettings.organizationId, o.orgId))))[0].requireMfa)
      .toBe(true);

    const folders = await listMailboxFolders(amy.ctx, done.connection.id);
    expect(folders.find((f) => f.isSent)).toMatchObject({ id: "f-sent", name: "Gesendete Elemente" });
    expect(folders.find((f) => f.isInbox)?.id).toBe("f-inbox");
  });

  it("asks Outlook for permission to send only when sending is turned on, from the same mailbox, then sends replies through it", async () => {
    const o = await makeOffice();
    const ms = withMicrosoft();
    const first = await completeMailboxConnection("microsoft", "code", stateOf(await startMailboxConnection(o.ctx, "microsoft", true)), o.ownerId);
    const id = first.connection.id;
    await configureMailbox(o.ctx, id,
      { folders: [{ id: "f-inbox", name: "Inbox" }], importFrom: "2026-01-01", sentFolder: { id: "f-sent", name: "Gesendete Elemente" } });
    await jobs();

    const asked = await turnOnSending(o.ctx, id, true);
    const url = new URL(asked.url!);
    expect(url.searchParams.get("scope")).toBe("offline_access openid email User.Read Mail.Read Mail.Send");
    expect(url.searchParams.get("login_hint")).toBe("rep@house.example.gov");

    ms.address = "someone.else@house.example.gov";
    ms.scope = "openid email User.Read Mail.Read Mail.Send";
    await expect(completeMailboxConnection("microsoft", "code", stateOf(asked.url!), o.ownerId)).rejects.toThrow(/Sign in as rep@house\.example\.gov/);
    ms.address = "rep@house.example.gov";
    ms.scope = "openid email User.Read Mail.Read";
    await expect(completeMailboxConnection("microsoft", "code", stateOf((await turnOnSending(o.ctx, id, true)).url!), o.ownerId))
      .rejects.toThrow(/Permission to send was not given/);
    expect((await mailbox(o.orgId, id)).sendEnabledAt).toBeNull();

    ms.scope = "openid email User.Read Mail.Read Mail.Send";
    const granted = await completeMailboxConnection("microsoft", "code", stateOf((await turnOnSending(o.ctx, id, true)).url!), o.ownerId);
    expect(granted.sendFor).toBe(id);
    expect((await mailbox(o.orgId, id)).sendEnabledAt).toBeNull();
    await proveSending(o.ctx, granted.connection);
    expect(ms.sentMail).toHaveLength(1);
    expect((await PostalMime.parse(ms.sentMail[0])).to?.[0].address).toBe("rep@house.example.gov");
    expect((await mailbox(o.orgId, id)).sendEnabledAt).not.toBeNull();

    const r = await ingestMessage(o.orgId, id, letterFor(1));
    const draft = await createReplyDraft(o.ctx, r.messageId);
    await updateReplyDraft(o.ctx, draft.id, "Dear Cy,\n\nThe library will stay open on Sundays.\n\nSincerely,\nRep. Test");
    await approveReplyDraft(o.ctx, draft.id);
    expect((await replyRoutes(o.ctx, [{ id: draft.id, connectionId: id }])).get(draft.id))
      .toMatchObject({ from: "rep@house.example.gov", opensIn: "outlook", canSend: true });
    await sendReplyDraft(o.ctx, draft.id);
    const mail = await PostalMime.parse(ms.sentMail[1]);
    expect(mail).toMatchObject({ subject: "Re: Library hours", inReplyTo: "<cy-1@mail.test>" });
    expect(mail.to?.[0].address).toBe("cy@mail.test");
    expect((await draftOf(o.orgId, draft.id)).status).toBe("sent");

    ms.scope = "openid email User.Read Mail.Read";
    await completeMailboxConnection("microsoft", "code", stateOf(await startMailboxConnection(o.ctx, "microsoft", true)), o.ownerId);
    expect(await mailbox(o.orgId, id)).toMatchObject({ status: "active", sendEnabledAt: null });
  });

  it("watches Gmail's Sent for replies without reading the rest, and sends through Gmail once allowed", async () => {
    const o = await makeOffice();
    const { gmail, conn } = await connectFakeGmail(o.orgId, o.ownerId, "rep@gmail.com");
    await configureMailbox(o.ctx, conn.id, { folders: [{ id: "INBOX", name: "Inbox" }], importFrom: "2026-01-01", sentFolder: { id: "SENT", name: "Sent" } });
    const letter = gmail.add({ from: "ann@mail.test", fromName: "Ann Lee", subject: "Potholes on Elm Street", body: LETTER.body, messageId: LETTER.id,
      threadId: "t-ann", date: new Date("2026-03-02T15:00:00Z") });
    const oldReply = gmail.add({ from: "rep@gmail.com", to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: ANSWER, labels: ["SENT"],
      threadId: "t-ann", date: new Date("2026-03-03T15:00:00Z") });
    const dinner = gmail.add({ from: "rep@gmail.com", to: "friend@elsewhere.test", subject: "Dinner on Friday", body: "Private plans.", labels: ["SENT"],
      date: new Date("2026-03-03T16:00:00Z") });
    await jobs();
    expect((await letterBy(o.orgId, "ann@mail.test")).triageStatus).toBe("done");
    expect(gmail.read).toContain(letter.id);
    expect(gmail.read).toContain(oldReply.id);
    expect(gmail.read).not.toContain(dinner.id);

    const ben = gmail.add({ from: "ben@mail.test", fromName: "Ben Ray", subject: "Bus route 9", body: "Please keep bus route 9 running on weekends.",
      messageId: "ben-1@mail.test", threadId: "t-ben" });
    await poll(o.orgId, conn.id);
    const lunch = gmail.add({ from: "rep@gmail.com", to: "friend@elsewhere.test", subject: "Lunch", body: "Private.", labels: ["SENT"] });
    gmail.add({ from: "rep@gmail.com", to: "ben@mail.test", subject: "Re: Bus route 9", body: "It will keep running.", labels: ["SENT"], threadId: "t-ben" });
    await poll(o.orgId, conn.id);
    expect((await letterBy(o.orgId, "ben@mail.test")).triageStatus).toBe("done");
    expect(gmail.read).toContain(ben.id);
    expect(gmail.read).not.toContain(lunch.id);

    process.env.GOOGLE_CLIENT_ID = "g-client";
    process.env.GOOGLE_CLIENT_SECRET = "g-secret";
    resetEnvForTests();
    const asked = await turnOnSending(o.ctx, conn.id, true);
    expect(new URL(asked.url!).searchParams.get("scope"))
      .toBe("openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send");
    gmail.scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
    const granted = await completeMailboxConnection("google", "code", stateOf(asked.url!), o.ownerId);
    await proveSending(o.ctx, granted.connection);
    expect(gmail.sent).toHaveLength(1);

    const cy = gmail.add({ from: "cy@mail.test", fromName: "Cy Dunn", subject: "Library hours", body: "Please keep the library open on Sundays.",
      messageId: "cy-1@mail.test", threadId: "t-cy" });
    await poll(o.orgId, conn.id);
    const m = await letterBy(o.orgId, "cy@mail.test");
    expect(cy.id).toBeTruthy();
    const draft = await createReplyDraft(o.ctx, m.id);
    await updateReplyDraft(o.ctx, draft.id, "Dear Cy,\n\nThe library will stay open on Sundays.\n\nSincerely,\nRep. Test");
    await approveReplyDraft(o.ctx, draft.id);
    await sendReplyDraft(o.ctx, draft.id);
    expect(gmail.sent[1].threadId).toBe("t-cy");
    expect(await PostalMime.parse(gmail.sent[1].raw)).toMatchObject({ subject: "Re: Library hours", inReplyTo: "<cy-1@mail.test>" });
    await poll(o.orgId, conn.id);
    expect(await repliesTo(o.orgId, m.id)).toHaveLength(1);
    expect((await stored(o.orgId)).filter((x) => x.direction === "outbound" && x.subject === "Re: Library hours")).toHaveLength(1);
  });

  it("says so when the person leaves Google's box for reading mail unticked, and links once it is ticked", async () => {
    const o = await makeOffice();
    process.env.GOOGLE_CLIENT_ID = "g-client";
    process.env.GOOGLE_CLIENT_SECRET = "g-secret";
    resetEnvForTests();
    const gmail = new FakeGmail("rep@gmail.com");
    setProviderFetchForTests(gmail.fetch);
    gmail.scope = "openid https://www.googleapis.com/auth/userinfo.email";
    await expect(completeMailboxConnection("google", "code", stateOf(await startMailboxConnection(o.ctx, "google", true)), o.ownerId))
      .rejects.toThrow(/did not give permission to read your email.*tick the box/);
    expect(await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailConnections).where(eq(emailConnections.organizationId, o.orgId))))
      .toHaveLength(0);
    gmail.scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly";
    const { connection } = await completeMailboxConnection("google", "code", stateOf(await startMailboxConnection(o.ctx, "google", true)), o.ownerId);
    expect(connection).toMatchObject({ provider: "google", emailAddress: "rep@gmail.com" });
  });
});

describe("the reply itself", () => {
  it("is written out safely, whatever is in the subject or the name", async () => {
    const raw = await buildReplyMime({ fromAddress: "rep@gmail.com", fromName: "Rep. José Ñandú",
      to: { address: "ann@mail.test", name: "Ann\r\nBcc: everyone@evil.test" }, subject: "Re: Año nuevo\r\nBcc: spy@evil.test",
      text: "Estimada Ann,\n\nGracias por escribir. — Oficina", messageId: "id-1@gmail.com", inReplyTo: "ann-1@mail.test", references: ["first@mail.test"] });
    const text = new TextDecoder().decode(raw);
    const head = text.split("\r\n\r\n")[0];
    expect(head).not.toMatch(/^Bcc:/im);
    const mail = await PostalMime.parse(raw);
    expect(mail.subject).toBe("Re: Año nuevo Bcc: spy@evil.test");
    expect(mail.from).toMatchObject({ address: "rep@gmail.com", name: "Rep. José Ñandú" });
    expect(mail.to).toHaveLength(1);
    expect(mail.messageId).toBe("<id-1@gmail.com>");
    expect(mail.references).toBe("<first@mail.test> <ann-1@mail.test>");
    expect(mail.text?.trim()).toBe("Estimada Ann,\n\nGracias por escribir. — Oficina");
    await expect(buildReplyMime({ fromAddress: "rep@gmail.com", fromName: null, to: { address: "ann@mail.test, spy@evil.test", name: null }, subject: "x",
      text: "x", messageId: "id-2@gmail.com", inReplyTo: null, references: [] })).rejects.toThrow(/not an address/);
  });

  it("opens in the person's own Outlook or Gmail already written, with several people in Bcc", () => {
    const one = composeLink("outlook", ["ann@mail.test"], "Re: Potholes", "Dear Ann,\nThank you.");
    expect(one)
      .toEqual({ href: "https://outlook.office.com/mail/deeplink/compose?to=ann%40mail.test&subject=Re%3A%20Potholes&body=Dear%20Ann%2C%0D%0AThank%20you.",
      carriesText: true });
    expect(composeLink("outlook_personal", ["ann@mail.test"], "Hi", "x").href).toMatch(/^https:\/\/outlook\.live\.com\/mail\/0\/deeplink\/compose\?to=/);
    expect(composeLink("gmail", ["ann@mail.test"], "Hi", "x").href).toBe("https://mail.google.com/mail/?view=cm&fs=1&to=ann%40mail.test&su=Hi&body=x");
    const many = composeLink("gmail", ["ann@mail.test", "ben@mail.test"], "HB 142", "x").href;
    expect(many).toContain("bcc=ann%40mail.test%2Cben%40mail.test");
    expect(many).not.toMatch(/[?&]to=/);
    expect(composeLink("mail", ["ann@mail.test"], "Hi", "x").href).toBe("mailto:ann@mail.test?subject=Hi&body=x");
    const long = composeLink("gmail", ["ann@mail.test"], "Hi", "word ".repeat(3000));
    expect(long.carriesText).toBe(false);
    expect(long.href).toBe("https://mail.google.com/mail/?view=cm&fs=1&to=ann%40mail.test&su=Hi");
  });

  it("closes with the office's signature when it has one", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    box.add("INBOX", LETTER);
    await poll(o.orgId, id);
    const m = await letterBy(o.orgId, "ann@mail.test");
    expect((await createReplyDraft(o.ctx, m.id)).bodyText.endsWith("Sincerely,\nRep. Test")).toBe(true);
    await setReplySignature(o.ctx, "With thanks,\r\nRep. Test\r\nDistrict 42 office, 555-0100\n");
    expect((await createReplyDraft(o.ctx, m.id)).bodyText.endsWith("[Office response]\n\nWith thanks,\nRep. Test\nDistrict 42 office, 555-0100")).toBe(true);
    const amy = await staff(o, "Amy", "legislative_aide");
    await expect(setReplySignature(amy.ctx, "Mine")).rejects.toThrow(/permission/);
    await expect(setReplySignature(o.ctx, "x".repeat(1001))).rejects.toThrow(/1,000/);
  });
});

describe("checking for new mail on request", () => {
  it("reads every linked mailbox now, once a minute at most", async () => {
    const o = await makeOffice();
    const box = new FakeImap(REP);
    const id = await link(o.ctx, box);
    box.add("INBOX", LETTER);
    expect(await checkMailNow(o.ctx)).toBe(1);
    expect(await checkMailNow(o.ctx)).toBe(1);
    const db = await systemDb();
    const queued = await db.select().from(backgroundJobs).where(like(backgroundJobs.idempotencyKey, `check-now:${id}:%`));
    expect(queued.length).toBeLessThanOrEqual(2);
    expect(queued.filter((q) => q.status === "queued")).toHaveLength(queued.length);
    await jobs();
    expect(await letterBy(o.orgId, "ann@mail.test")).toBeTruthy();
  });
});

describe("getting the office's own records out", () => {
  it("gives the owner every letter and every bill position as rows, and nobody else", async () => {
    const { billPositionsForExport, mailForExport } = await import("@/server/services/center");
    const { receive } = await import("../helpers/messages");
    const o = await makeOffice();
    await receive(o.orgId, { from: "ann@mail.test", name: "Ann Lee", subject: "Vote yes on HB 142",
      body: "Please vote yes on HB 142. I support HB 142 because school lunches matter to my family." });
    await receive(o.orgId, { from: "ben@mail.test", name: "Ben Ray", subject: "=SUM(A1:A9)", body: "Please fix the potholes on my road." });
    await jobs();
    const mail = await mailForExport(o.ctx);
    expect(mail.map((r) => r.address).sort()).toEqual(["ann@mail.test", "ben@mail.test"]);
    expect(mail.find((r) => r.address === "ann@mail.test")).toMatchObject({ name: "Ann Lee", bills: "HB 142 (supports)" });
    expect(mail.find((r) => r.address === "ben@mail.test")?.issues).toContain("Road");
    expect(await billPositionsForExport(o.ctx))
      .toMatchObject([{ reference: "HB 142", name: "Ann Lee", address: "ann@mail.test", position: "support", requested_action: "vote_yes" }]);
    const chief = await staff(o, "Cam", "chief_of_staff");
    await expect(mailForExport(chief.ctx)).rejects.toThrow(/permission/);
    await expect(billPositionsForExport(chief.ctx)).rejects.toThrow(/permission/);
  });
});

describe("the mail list", () => {
  it("calls a letter a form letter only when at least two people sent the same wording", async () => {
    const { listInbox } = await import("@/server/services/inbox");
    const { receive } = await import("../helpers/messages");
    const o = await makeOffice();
    const own = "The potholes on Elm Street have damaged two of my tires this month and the county has not answered my calls. Please ask the road crew to repair the street before winter arrives.";
    const shared = "I urge you to vote yes on the school lunch bill this session. Every child in our district deserves a healthy meal at school, and this bill pays for it without raising local taxes.";
    await receive(o.orgId, { from: "ann@mail.test", name: "Ann Lee", subject: "Elm Street", body: own });
    await receive(o.orgId, { from: "ben@mail.test", name: "Ben Ray", subject: "School lunches", body: shared });
    await receive(o.orgId, { from: "cy@mail.test", name: "Cy Dunn", subject: "School lunches", body: shared });
    await jobs();
    const list = (await listInbox(o.ctx, {})).items;
    expect(list.find((m) => m.fromAddress === "ann@mail.test")?.formLetter).toBe(false);
    expect(list.filter((m) => m.formLetter).map((m) => m.fromAddress).sort()).toEqual(["ben@mail.test", "cy@mail.test"]);
  });
});

describe("finding out how an address connects", () => {
  const records = (over: Partial<import("@/server/email/providers/imap").MailRecords>) => ({ mx: async () => [], txt: async () => [], cname: async () => [],
    microsoftDirectory: async () => false, ...over });
  const service = async (email: string) => (await import("@/server/email/providers/imap")).findMailService(email);

  afterEach(async () => {
    (await import("@/server/email/providers/imap")).setMailRecordsForTests(null);
  });

  it("sees Outlook behind a mail filter, the way a GoDaddy or Proofpoint office is set up", async () => {
    const { setMailRecordsForTests } = await import("@/server/email/providers/imap");
    const { describeMailbox } = await import("@/server/email/connections");
    // Microsoft 365 behind Proofpoint: only the non-MX records name Microsoft.
    setMailRecordsForTests(records({ mx: async () => ["mx1-usg2.ppe-hosted.com.", "mx2-usg2.ppe-hosted.com."],
      txt: async () => ["v=spf1 include:_spf-usg2.ppe-hosted.com include:secureserver.net ~all", "netorgft0000000.onmicrosoft.com"] }));
    expect(await service("someone@filtered-office.example")).toMatchObject({ kind: "microsoft", label: "Outlook" });
    const o = await makeOffice();
    expect(await describeMailbox(o.ctx, "someone@filtered-office.example")).toMatchObject({ label: "Outlook", outlook: true, password: false, signIn: null });
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    resetEnvForTests();
    expect(await describeMailbox(o.ctx, "someone@filtered-office.example")).toMatchObject({ signIn: "microsoft", password: false });
    await expect(connectPasswordMailbox(o.ctx, { email: "someone@filtered-office.example", password: "abcdefghijklmnop", acknowledged: true }))
      .rejects.toThrow(/Connect Outlook/);
  });

  it("uses each kind of record a domain may publish, and guesses nothing when there is none", async () => {
    const { setMailRecordsForTests } = await import("@/server/email/providers/imap");
    setMailRecordsForTests(records({ mx: async () => ["office-example.mail.protection.outlook.com."] }));
    expect((await service("a@direct.example")).kind).toBe("microsoft");
    setMailRecordsForTests(records({ mx: async () => ["us-smtp-inbound-1.mimecast.com"],
      cname: async (host) => (host === "autodiscover.auto.example" ? ["autodiscover.outlook.com."] : []) }));
    expect((await service("a@auto.example")).kind).toBe("microsoft");
    setMailRecordsForTests(records({ mx: async () => ["d1234.a.ess.barracudanetworks.com"], txt: async () => ["v=spf1 include:_spf.google.com ~all"] }));
    expect(await service("a@workspace.example")).toMatchObject({ kind: "google", label: "Gmail", hosts: ["imap.gmail.com"] });
    setMailRecordsForTests(records({ mx: async () => ["mail.filter.example"], microsoftDirectory: async (d) => d === "directory.example" }));
    expect((await service("a@directory.example")).kind).toBe("microsoft");
    setMailRecordsForTests(records({ mx: async () => ["mx.selfhosted.example"] }));
    expect(await service("a@selfhosted.example")).toMatchObject({ kind: "password", hosts: ["imap.selfhosted.example", "mail.selfhosted.example"] });
  });

  it("turns away a regular password before it is tried against anyone's mail service", async () => {
    const { appPasswordProblem, cleanAppPassword } = await import("@/lib/app-password");
    expect(appPasswordProblem("Gmail", "letters16", "abcd efgh ijkl mnop")).toBeNull();
    expect(cleanAppPassword("letters16", " abcd efgh ijkl mnop ")).toBe("abcdefghijklmnop");
    expect(appPasswordProblem("Gmail", "letters16", "MyGmail2026")).toMatch(/not a Gmail app password.*16 letters.*regular Gmail password does not work/);
    expect(appPasswordProblem("iCloud", "apple", "abcd-efgh-ijkl-mnop")).toBeNull();
    expect(appPasswordProblem("iCloud", "apple", "hunter2")).toMatch(/four groups of four letters/);
    expect(appPasswordProblem("mail.example", null, "anything at all")).toBeNull();

    const o = await makeOffice();
    const box = new FakeImap("rep@gmail.com");
    setImapOpenerForTests(box.open);
    await expect(connectPasswordMailbox(o.ctx, { email: "rep@gmail.com", password: "MyGmail2026", acknowledged: true }))
      .rejects.toThrow(/not a Gmail app password/);
    expect(box.logins).toHaveLength(0);
    expect(await mailboxes(o.orgId)).toHaveLength(0);
  });

  it("gives an office one link for its IT administrator, for reading only", async () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    resetEnvForTests();
    const approval = await import("@/app/api/integrations/[provider]/approval/route");
    const sent = await approval.GET(new Request("http://localhost:3000/api/integrations/microsoft/approval"),
      { params: Promise.resolve({ provider: "microsoft" }) });
    const to = new URL(sent.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(to.searchParams.get("scope")).toBe("openid email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read");
    expect(to.searchParams.get("scope")).not.toMatch(/Send|ReadWrite/);
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/integrations/microsoft/callback");
    expect((await approval.GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ provider: "google" }) })).status).toBe(404);

    const callback = await import("@/app/api/integrations/[provider]/callback/route");
    const back = (query: string) =>
      callback.GET(new Request(`http://localhost:3000/api/integrations/microsoft/callback?state=${to.searchParams.get("state")}&${query}`),
      { params: Promise.resolve({ provider: "microsoft" }) });
    const ok = await back("admin_consent=True&tenant=11111111-2222-3333-4444-555555555555");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Constituent Center is approved for your organization");
    const no = await back("admin_consent=True&error=consent_required");
    expect(no.status).toBe(400);
    expect(await no.text()).toContain("was not approved");
  });
});

describe("Needs a person, by district", () => {
  it("narrows the list to people in the district, outside it, or not yet placed", async () => {
    const { needsAPerson } = await import("@/server/services/center");
    const { setContactDistrict } = await import("@/server/services/district");
    const { receive } = await import("../helpers/messages");
    const o = await makeOffice();
    const ann = await receive(o.orgId, { from: "ann@mail.test", name: "Ann Lee", subject: "Unemployment claim",
      body: "I need help with my unemployment claim. It has been stuck for six weeks and nobody at the Department of Labor will call me back." });
    const ben = await receive(o.orgId, { from: "ben@mail.test", name: "Ben Ray", subject: "Driver's license",
      body: "Can you help me get my driver's license renewed? The Department of Driver Services lost my paperwork twice and I cannot get to work." });
    await receive(o.orgId, { from: "cy@mail.test", name: "Cy Dunn", subject: "Medicaid",
      body: "Please help my mother with her Medicaid application. She was denied last month and we do not understand the letter they sent." });
    await jobs();
    const who = async (district?: "in" | "outside" | "unknown") => {
      const d = await needsAPerson(o.ctx, { district });
      return [...new Set([...d.urgent, ...d.casework, ...d.others].map((a) => a.fromAddress))].sort();
    };
    expect(await who()).toEqual(["ann@mail.test", "ben@mail.test", "cy@mail.test"]);
    expect((await needsAPerson(o.ctx)).anyonePlaced).toBe(false);
    await setContactDistrict(o.ctx, ann.contactId!, "in_district");
    await setContactDistrict(o.ctx, ben.contactId!, "out_of_state");
    expect((await needsAPerson(o.ctx)).anyonePlaced).toBe(true);
    expect(await who("in")).toEqual(["ann@mail.test"]);
    expect(await who("outside")).toEqual(["ben@mail.test"]);
    expect(await who("unknown")).toEqual(["cy@mail.test"]);
  });
});
