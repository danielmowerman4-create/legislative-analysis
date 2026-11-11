import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { closeDb, withTenant } from "@/server/db/client";
import { contactEmails, emailMessages, mailLedger, reviewQueue } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { addSenderRule, billCorrespondence, enableConstituentCenter, listFormLetters, listSenderRules, needsAPerson,
  setSenderRuleStatus } from "@/server/services/center";
import { listInbox } from "@/server/services/inbox";

beforeAll(async () => {
  await freshDatabase();
});
afterAll(() => closeDb());

async function office() {
  const o = await makeOffice();
  await enableConstituentCenter(o.orgId);
  return o;
}

const classifyAll = () => drainJobs(["classify"]);
const message = async (orgId: string, id: string) => (await withTenant({ orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.id, id))))[0];
const entry = async (orgId: string, messageId: string) => (await withTenant({ orgId },
  (tx) => tx.select().from(mailLedger).where(eq(mailLedger.messageId, messageId)))).filter((x) => x.disposition !== "duplicate")[0];
const contactOf = async (orgId: string, address: string) => (await withTenant({ orgId }, (tx) => tx.select({ id: contactEmails.contactId }).from(contactEmails)
  .where(and(eq(contactEmails.organizationId, orgId), eq(contactEmails.email, address)))))[0]?.id ?? null;
const addressOf = (name: string) => `${name.toLowerCase().replace(" ", ".")}@mail.test`;

const LETTER = (name: string) => `Dear Representative,

I am asking you to protect funding for rural health clinics in the coming budget. Clinics in our part of the state are the only place many families can see a doctor without driving more than an hour. Cutting the clinic grant program would close doors that will not reopen and push more people into emergency rooms that are already full.

Please vote NO on HB 142 and keep the rural clinic grants in the budget.

Sincerely,
${name}`;

// One signer's letter through a platform the office has never listed.
const through = (orgId: string, from: string, name: string, headers?: Record<string, string>, at?: Date) => receive(orgId,
  { from, name: `${name} via CivicPush`, replyTo: { address: addressOf(name), name }, headers, body: LETTER(name), at });

const SIGNERS: [string, Record<string, string> | undefined][] = [
  ["Bob Brown", { precedence: "bulk" }],
  ["Cat Clark", { precedence: "bulk", "auto-submitted": "auto-generated" }],
  ["Dan Diaz", { "auto-submitted": "auto-generated" }],
  ["Eve Evans", undefined],
];

describe("mail a sender writes for someone else", () => {
  it("keeps letters from a platform the office has not listed in the mail, and suggests the platform", async () => {
    const o = await office();
    const sent = [];
    for (const [name, headers] of SIGNERS) sent.push(await through(o.orgId, "no-reply@civicpush.test", name, headers));
    await classifyAll();

    const inbox = (await listInbox(o.ctx, {})).items.map((i) => i.id);
    for (const s of sent) {
      expect(await message(o.orgId, s.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false, senderTrust: "verified" });
      expect((await entry(o.orgId, s.messageId)).disposition).toBe("filed");
      expect(inbox).toContain(s.messageId);
    }
    const rules = (await listSenderRules(o.ctx)).filter((r) => r.value === "no-reply@civicpush.test");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: "relay", matchType: "address", status: "proposed", proposedBy: "system",
      reason: "Its mail names different people as the writers." });
  });

  it("counts every signer once the office confirms the platform, mail already read included", async () => {
    const o = await office();
    const sent = [];
    for (const [name, headers] of SIGNERS) sent.push(await through(o.orgId, "no-reply@civicpush.test", name, headers));
    await classifyAll();
    expect((await billCorrespondence(o.ctx, "HB 142")).people).toBe(1);
    expect(await contactOf(o.orgId, addressOf("Bob Brown"))).toBeNull();

    const [rule] = (await listSenderRules(o.ctx)).filter((r) => r.value === "no-reply@civicpush.test");
    await setSenderRuleStatus(o.ctx, rule.id, "active");
    await classifyAll();

    for (const [i, s] of sent.entries()) {
      const name = SIGNERS[i][0];
      const m = await message(o.orgId, s.messageId);
      expect(m).toMatchObject({ triageStatus: "new", senderTrust: "relay", claimedAddress: addressOf(name), claimedName: name, duplicateOfId: null,
        isAutomated: false });
      expect(m.contactId).toBe(await contactOf(o.orgId, addressOf(name)));
      expect(m.messageTypes[0]).toBe("constituent_policy");
    }
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 4, positions: { oppose: 4 } });
    expect((await listFormLetters(o.ctx))[0]).toMatchObject({ people: 4, bill: "HB 142", stance: "oppose" });
    expect(await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(reviewQueue)
      .where(and(eq(reviewQueue.organizationId, o.orgId), eq(reviewQueue.kind, "contact_match"), eq(reviewQueue.status, "open"))))).toHaveLength(0);
    const next = await through(o.orgId, "no-reply@civicpush.test", "Fay Ford", { "list-unsubscribe": "<mailto:unsub@civicpush.test>" });
    await classifyAll();
    expect(await message(o.orgId, next.messageId)).toMatchObject({ senderTrust: "relay", claimedAddress: addressOf("Fay Ford"), triageStatus: "new" });
    expect((await billCorrespondence(o.ctx, "HB 142")).people).toBe(5);
    expect((await listSenderRules(o.ctx)).filter((r) => r.kind === "hide")).toHaveLength(0);
  });

  it("leaves mail with an unsubscribe or list header set aside until the office lists the sender, and still suggests it", async () => {
    const o = await office();
    const names = ["Bob Brown", "Cat Clark", "Dan Diaz"];
    const marks: Record<string, string>[] = [{ "list-unsubscribe": "<mailto:unsub@civicpush.test>" }, { "list-id": "<letters.civicpush.test>" },
      { precedence: "list" }];
    const sent = [];
    for (const [i, name] of names.entries()) sent.push(await through(o.orgId, "no-reply@civicpush.test", name, marks[i]));
    await classifyAll();
    for (const s of sent) {
      expect(await message(o.orgId, s.messageId)).toMatchObject({ triageStatus: "archived", isAutomated: true, senderTrust: "verified" });
      expect((await entry(o.orgId, s.messageId)).disposition).toBe("screened");
    }
    const rules = (await listSenderRules(o.ctx)).filter((r) => r.value === "no-reply@civicpush.test");
    expect(rules.map((r) => [r.kind, r.status])).toEqual([["relay", "proposed"]]);

    await setSenderRuleStatus(o.ctx, rules[0].id, "active");
    await classifyAll();
    for (const [i, s] of sent.entries()) {
      expect(await message(o.orgId, s.messageId))
        .toMatchObject({ triageStatus: "new", isAutomated: false, senderTrust: "relay", claimedAddress: addressOf(names[i]) });
      expect(await entry(o.orgId, s.messageId)).toMatchObject({ disposition: "filed", reason: "Read again and returned to the mail." });
    }
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 3, positions: { oppose: 3 } });
    expect((await listSenderRules(o.ctx)).filter((r) => r.kind === "hide")).toHaveLength(0);
  });

  it("does the same when the office adds the platform's whole domain by hand", async () => {
    const o = await office();
    const hourAgo = new Date(Date.now() - 3600_000);
    const a = await through(o.orgId, "letters@send.civicpush.test", "Bob Brown", { precedence: "bulk" }, hourAgo);
    const again = await through(o.orgId, "letters@send.civicpush.test", "Bob Brown", { precedence: "bulk" });
    const b = await through(o.orgId, "campaigns@civicpush.test", "Cat Clark");
    await classifyAll();

    await addSenderRule(o.ctx, { kind: "relay", value: "civicpush.test" });
    await classifyAll();
    expect(await message(o.orgId, a.messageId)).toMatchObject({ senderTrust: "relay", claimedAddress: addressOf("Bob Brown"), duplicateOfId: null });
    expect(await message(o.orgId, again.messageId)).toMatchObject({ senderTrust: "relay", duplicateOfId: a.messageId });
    expect(await message(o.orgId, b.messageId)).toMatchObject({ senderTrust: "relay", claimedAddress: addressOf("Cat Clark"), duplicateOfId: null });
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 2, positions: { oppose: 2 } });
  });

  it("turns a contact form on the office's own site into the requests of the people who filled it in", async () => {
    const o = await office();
    const ask = (name: string) => `Dear Representative, my unemployment claim has been stuck for nine weeks and nobody at the Department of Labor answers the phone. Can your office help me? Thank you, ${name}`;
    const form = (name: string) => receive(o.orgId,
      { from: "no-reply@house.example.gov", name: "House Website", subject: "Contact form", replyTo: { address: addressOf(name), name }, body: ask(name) });
    const sent = [await form("Gina Gray"), await form("Hal Hunt")];
    await classifyAll();
    // Unlisted: it reads as the office's own, stays in the mail and is suggested.
    const inbox = (await listInbox(o.ctx, {})).items.map((i) => i.id);
    for (const s of sent) {
      expect(await message(o.orgId, s.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false, isInternal: true });
      expect(inbox).toContain(s.messageId);
    }
    const [rule] = (await listSenderRules(o.ctx)).filter((r) => r.value === "no-reply@house.example.gov");
    expect(rule).toMatchObject({ kind: "relay", status: "proposed" });

    await setSenderRuleStatus(o.ctx, rule.id, "active");
    await classifyAll();
    for (const [i, s] of sent.entries()) {
      const name = ["Gina Gray", "Hal Hunt"][i];
      const m = await message(o.orgId, s.messageId);
      expect(m).toMatchObject({ senderTrust: "relay", claimedAddress: addressOf(name), isInternal: false, duplicateOfId: null });
      expect(m.contactId).toBe(await contactOf(o.orgId, addressOf(name)));
      expect(m.messageTypes[0]).toBe("constituent_service");
    }
    const waiting = await needsAPerson(o.ctx);
    expect([...waiting.urgent, ...waiting.casework].map((a) => a.messageId)).toEqual(expect.arrayContaining(sent.map((s) => s.messageId)));
  });

  it("puts the mail back with the sender when the office turns the platform off", async () => {
    const o = await office();
    await addSenderRule(o.ctx, { kind: "relay", value: "no-reply@civicpush.test" });
    const a = await through(o.orgId, "no-reply@civicpush.test", "Bob Brown");
    const b = await through(o.orgId, "no-reply@civicpush.test", "Cat Clark");
    await classifyAll();
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 2 });

    const [rule] = (await listSenderRules(o.ctx)).filter((r) => r.value === "no-reply@civicpush.test");
    await setSenderRuleStatus(o.ctx, rule.id, "retired");
    await classifyAll();
    const platform = await contactOf(o.orgId, "no-reply@civicpush.test");
    expect(platform).not.toBeNull();
    for (const s of [a, b]) expect(await message(o.orgId, s.messageId)).toMatchObject({ senderTrust: "verified", contactId: platform, triageStatus: "new" });
    expect((await billCorrespondence(o.ctx, "HB 142")).people).toBe(1);
  });

  it("leaves a sender nobody could confirm alone, whatever the office lists", async () => {
    const o = await office();
    const forged = await receive(o.orgId,
      { from: "no-reply@civicpush.test", name: "Bob Brown via CivicPush", replyTo: { address: addressOf("Bob Brown"), name: "Bob Brown" },
      body: LETTER("Bob Brown"), auth: "mx.test; spf=fail smtp.mailfrom=elsewhere.test; dkim=none; dmarc=fail header.from=civicpush.test" });
    await classifyAll();
    await addSenderRule(o.ctx, { kind: "relay", value: "civicpush.test" });
    await classifyAll();
    expect(await message(o.orgId, forged.messageId)).toMatchObject({ senderTrust: "failed", contactId: null });
    expect((await entry(o.orgId, forged.messageId)).disposition).toBe("held");
  });

  it("still sets aside a mailing list that answers to its own address", async () => {
    const o = await office();
    const own = await receive(o.orgId, { from: "news@civic.test", replyTo: { address: "info@civic.test" }, subject: "This week at the Capitol",
      body: "This week at the Capitol and what to expect next.", headers: { "list-id": "<weekly.civic.test>" } });
    const sub = await receive(o.orgId, { from: "weekly@mail.civic.test", replyTo: { address: "editor@civic.test" }, subject: "Committee calendar",
      body: "Committee hearings scheduled for the coming week.", headers: { "list-unsubscribe": "<mailto:leave@civic.test>" } });
    const service = await receive(o.orgId, { from: "digest@sender.test", replyTo: { address: "support@helpdesk.test" }, subject: "Your digest",
      body: "Stories you may have missed this month.", headers: { precedence: "bulk" } });
    const role = await receive(o.orgId, { from: "no-reply@brightco-mail.test", replyTo: { address: "hello@brightshop.test" }, subject: "New this week",
      body: "New arrivals and what is back in stock." });
    const bill = await receive(o.orgId, { from: "no-reply@statements.test", replyTo: { address: "billing@powerco.test" }, subject: "Your statement is ready",
      body: "Your statement for this month is ready to view." });
    const sameOrg = await receive(o.orgId, { from: "weekly@em.riverkeeper-news.test", replyTo: { address: "dana.lopez@riverkeeper.test", name: "Dana Lopez" },
      subject: "River report", body: "What we found on the river this month and how to help.", headers: { precedence: "bulk" } });
    await classifyAll();
    for (const r of [own, sub, service, role, bill, sameOrg]) {
      expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "archived", isAutomated: true });
      expect((await entry(o.orgId, r.messageId)).disposition).toBe("screened");
    }
    expect((await listSenderRules(o.ctx)).filter((r) => r.kind === "relay" && r.status === "proposed")).toHaveLength(0);
  });

  it("sets aside a newsletter with an unsubscribe header even when it names a person, and offers a rule for it", async () => {
    const o = await office();
    const sent = [];
    for (const week of ["first", "second", "third"]) sent.push(await receive(o.orgId,
      { from: "pta@shared.mailer.test", name: "Oak Street PTA", replyTo: { address: "oak.pta.president@homepost.test" }, subject: `PTA news, ${week} week`,
      body: `Here is what is happening at Oak Street School in the ${week} week of the month.`,
      headers: { "list-unsubscribe": "<mailto:leave@mailer.test>" } }));
    await classifyAll();
    // The office is on its list; one fixed name means it is not a platform.
    for (const s of sent) {
      expect(await message(o.orgId, s.messageId)).toMatchObject({ triageStatus: "archived", isAutomated: true });
      expect((await entry(o.orgId, s.messageId)).disposition).toBe("screened");
    }
    const rules = (await listSenderRules(o.ctx)).filter((r) => r.value === "pta@shared.mailer.test");
    expect(rules.map((r) => [r.kind, r.status])).toEqual([["hide", "proposed"]]);
  });

  it("keeps a newsletter without a list header in the mail when it names a person, for the office to decide", async () => {
    const o = await office();
    const r = await receive(o.orgId, { from: "no-reply@shared.mailer.test", name: "Oak Street PTA", replyTo: { address: "oak.pta.president@homepost.test" },
      subject: "PTA news", body: "Here is what is happening at Oak Street School this month.", headers: { precedence: "bulk" } });
    await classifyAll();
    expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false });
    expect((await entry(o.orgId, r.messageId)).disposition).toBe("filed");
  });

  it("returns letters an earlier reading set aside when they are read again", async () => {
    const o = await office();
    const r = await through(o.orgId, "no-reply@civicpush.test", "Bob Brown", { precedence: "bulk" });
    await classifyAll();
    // As the reading rules before this change left it.
    await withTenant({ orgId: o.orgId }, async (tx) => {
      await tx.update(emailMessages).set({ triageStatus: "archived", isAutomated: true }).where(eq(emailMessages.id, r.messageId));
      await tx.update(mailLedger).set({ disposition: "screened", reason: "Looks like a mailing list or automatic mail (Precedence: bulk, no-reply sender)." })
        .where(eq(mailLedger.messageId, r.messageId));
    });
    await enqueue("message.classify", { messageId: r.messageId, rulesOnly: true }, { orgId: o.orgId, idempotencyKey: `again:${r.messageId}` });
    await classifyAll();
    expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false });
    expect(await entry(o.orgId, r.messageId)).toMatchObject({ disposition: "filed", reason: "Read again and returned to the mail." });
  });
});
