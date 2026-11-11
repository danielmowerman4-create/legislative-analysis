import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { withTenant } from "@/server/db/client";
import { agencyDirectory, bills, cases, contacts, emailMessages, messageAsks, trackedBills } from "@/server/db/schema";
import { drainJobs } from "@/server/jobs/runner";
import { DEMO_SESSIONS, demoLegislativeDataset } from "@/server/demo/legislative-fixture";
import { FixtureProvider } from "@/server/legislation/providers/fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { updateCase } from "@/server/services/cases";
import { enableConstituentCenter, openCaseFromAsk } from "@/server/services/center";
import { addContactNote, getContactDetail } from "@/server/services/contacts";
import { addMessageNote, assignMessage } from "@/server/services/corrections";
import { getMessageDetail } from "@/server/services/inbox";
import { trackBills, updateTracking } from "@/server/services/legislation";
import { addMember } from "@/server/services/offices";
import { approveReplyDraft, createReplyDraft, listDrafts, listSentReplies, markReplySent, sendReplyDraft, updateReplyDraft } from "@/server/services/replies";

async function office() {
  const o = await makeOffice();
  await enableConstituentCenter(o.orgId);
  return o;
}

beforeAll(async () => {
  await freshDatabase();
});

describe("sensitive mail", () => {
  it("shows no more of it in replies, a person's record or their earlier letters than the inbox does", async () => {
    const o = await office();
    const aide = await contextFor(await addMember(o.ctx,
      { email: `aide-${o.orgId}@example.test`, name: "Aide", roleKey: "legislative_aide", password: "correct horse battery staple" }), o.orgId);
    const caseworker = await contextFor(await addMember(o.ctx,
      { email: `cw-${o.orgId}@example.test`, name: "Caseworker", roleKey: "caseworker", password: "correct horse battery staple" }), o.orgId);
    const secret = await receive(o.orgId,
      { from: "ida@mail.test", name: "Ida Moss", subject: "My status", body: "My immigration status is at risk and I need help with USCIS." });
    const plain = await receive(o.orgId,
      { from: "ida@mail.test", name: "Ida Moss", subject: "Bus route", body: "Please keep the number 9 bus running on Sundays." });
    await drainJobs(["classify"]);
    const [m] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.id, secret.messageId)));
    expect(m.isSensitive).toBe(true);

    const earlier = (await getMessageDetail(aide, plain.messageId)).previous.find((p) => p.id === secret.messageId)!;
    expect(earlier.subject).toBe("Sensitive message");
    expect((await getMessageDetail(caseworker, plain.messageId)).previous.find((p) => p.id === secret.messageId)!.subject).toBe("My status");
    const record = await getContactDetail(aide, m.contactId!);
    expect(record.timeline.find((t) => t.id === secret.messageId)!.title).toBe("Sensitive message");
    expect(JSON.stringify(record)).not.toMatch(/My status|USCIS/);

    await expect(createReplyDraft(aide, secret.messageId)).rejects.toThrow(/restricted/);
    const draft = await createReplyDraft(caseworker, secret.messageId);
    await updateReplyDraft(caseworker, draft.id, "Dear Ida,\n\nWe have asked USCIS about your case.");
    await expect(updateReplyDraft(aide, draft.id, "Changed by someone who cannot read it.")).rejects.toThrow(/restricted/);
    await approveReplyDraft(o.ctx, draft.id);
    await expect(sendReplyDraft(aide, draft.id)).rejects.toThrow(/restricted/);
    const open = (await listDrafts(aide)).find((d) => d.id === draft.id)!;
    expect(open).toMatchObject({ subject: "Sensitive message", bodyText: "" });
    expect((await listDrafts(caseworker)).find((d) => d.id === draft.id)!.bodyText).toContain("USCIS");

    await markReplySent(o.ctx, draft.id);
    const sent = (await listSentReplies(aide)).find((d) => d.id === draft.id)!;
    expect(sent).toMatchObject({ subject: "Sensitive message", bodyText: "" });
    expect((await listSentReplies(o.ctx)).find((d) => d.id === draft.id)!.subject).toBe("Re: My status");
  });

  it("cannot be opened by assigning it to yourself", async () => {
    const o = await office();
    const aide = await contextFor(await addMember(o.ctx,
      { email: `aide-${o.orgId}@example.test`, name: "Aide", roleKey: "legislative_aide", password: "correct horse battery staple" }), o.orgId);
    const secret = await receive(o.orgId,
      { from: "ida@mail.test", name: "Ida Moss", subject: "My status", body: "My immigration status is at risk and I need help with USCIS." });
    await drainJobs(["classify"]);
    const assignee = () => withTenant({ orgId: o.orgId }, (tx) =>
      tx.select({ assignedTo: emailMessages.assignedTo }).from(emailMessages).where(eq(emailMessages.id, secret.messageId)));

    await expect(assignMessage(aide, secret.messageId, aide.userId)).rejects.toThrow(/restricted/);
    await expect(addMessageNote(aide, secret.messageId, "Seen")).rejects.toThrow(/restricted/);
    expect((await assignee())[0].assignedTo).toBeNull();
    await assignMessage(o.ctx, secret.messageId, aide.userId);
    expect((await assignee())[0].assignedTo).toBe(aide.userId);
    await addMessageNote(aide, secret.messageId, "Now mine to handle.");
  });

  it("refuses a note on a person from another office", async () => {
    const [a, b] = [await office(), await office()];
    const theirs = await receive(b.orgId, { from: "omar@mail.test", name: "Omar Reid", subject: "Roads", body: "Please fix the potholes on Elm Street." });
    const [m] = await withTenant({ orgId: b.orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.id, theirs.messageId)));
    await expect(addContactNote(a.ctx, m.contactId!, "Not ours", "office")).rejects.toThrow(/not found/i);
  });
});

describe("what a form can change", () => {
  it("changes only a tracked bill's own details, whatever else is sent", async () => {
    await syncJurisdiction("ZZ", { provider: new FixtureProvider(demoLegislativeDataset()), sessionIdentifiers: DEMO_SESSIONS().map((x) => x.identifier) });
    const o = await office();
    const [a, b] = await withTenant({ orgId: o.orgId }, (tx) => tx.select({ id: bills.id }).from(bills).limit(2));
    await trackBills(o.ctx, [a.id], { position: "watching", priority: "normal" });
    await updateTracking(o.ctx, a.id, { nextStep: "Call the chair", billId: b.id, trackedBy: null, createdAt: new Date(0) } as never);
    const [row] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(trackedBills).where(eq(trackedBills.organizationId, o.orgId)));
    expect(row).toMatchObject({ billId: a.id, trackedBy: o.ownerId, nextStep: "Call the chair" });
    expect(row.createdAt.getTime()).toBeGreaterThan(0);
  });

  it("opens a case for the person who wrote, with this office's own agency only", async () => {
    const o = await office();
    const other = await office();
    const [theirAgency] = await withTenant({ orgId: other.orgId },
      (tx) => tx.insert(agencyDirectory).values({ organizationId: other.orgId, name: "Their agency" }).returning());
    const [theirPerson] = await withTenant({ orgId: other.orgId },
      (tx) => tx.insert(contacts).values({ organizationId: other.orgId, kind: "person", fullName: "Someone Else" }).returning());
    const r = await receive(o.orgId,
      { from: "pat@mail.test", name: "Pat Doe", body: "My unemployment claim has been stuck for two months. Can your office help?" });
    const [ask] = await withTenant({ orgId: o.orgId }, (tx) => tx.insert(messageAsks).values({ organizationId: o.orgId, messageId: r.messageId,
      kind: "casework", summary: "Claim stuck", quote: "My unemployment claim", quoteStart: 0, quoteEnd: 21, source: "staff" }).returning());

    await expect(openCaseFromAsk(o.ctx, ask.id, { title: "Claim", category: "labor", assignedTo: null, agencyId: theirAgency.id })).rejects.toThrow(/agency/);
    const c = await openCaseFromAsk(o.ctx, ask.id,
      { title: "Claim", category: "labor", assignedTo: null, agencyId: null, contactId: theirPerson.id, isSensitive: false } as never);
    const [m] = await withTenant({ orgId: o.orgId },
      (tx) => tx.select({ contactId: emailMessages.contactId }).from(emailMessages).where(eq(emailMessages.id, r.messageId)));
    expect(c.contactId).toBe(m.contactId);
    await expect(updateCase(o.ctx, c.id, { agencyId: theirAgency.id })).rejects.toThrow(/agency/);
    const [saved] = await withTenant({ orgId: o.orgId }, (tx) => tx.select({ agencyId: cases.agencyId }).from(cases).where(eq(cases.id, c.id)));
    expect(saved.agencyId).toBeNull();
  });
});
