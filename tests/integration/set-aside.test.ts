import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { closeDb, withTenant } from "@/server/db/client";
import { emailMessages, mailLedger, reviewQueue } from "@/server/db/schema";
import { setAiProviderForTests, type AiClassification, type AiProvider } from "@/server/ai/provider";
import { enqueue } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { addSenderRule, billCorrespondence, enableConstituentCenter, ledgerOverview, listFormLetters, needsAPerson,
  restoreFromLedger, setupStatus } from "@/server/services/center";
import { BROUGHT_BACK } from "@/server/classification/pipeline";
import { listInbox } from "@/server/services/inbox";

beforeAll(async () => {
  await freshDatabase();
});
afterEach(() => setAiProviderForTests(undefined));
afterAll(() => closeDb());

async function office() {
  const o = await makeOffice();
  await enableConstituentCenter(o.orgId);
  return o;
}

function fakeAi(over: Partial<AiClassification>) {
  const calls: string[] = [];
  const provider: AiProvider = {
    model: "fake",
    classify: async (input) => {
      calls.push(input.text);
      return { message_types: [], summary: "", issues: [], positions: [], requested_actions: [], bills: [], asks: [], ...over };
    },
    generate: async () => null,
  };
  setAiProviderForTests(provider);
  return calls;
}

const classifyAll = () => drainJobs(["classify"]);
const message = async (orgId: string, id: string) => (await withTenant({ orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.id, id))))[0];
// The message's own ledger line, not a duplicate's.
const entry = async (orgId: string, messageId: string) => (await withTenant({ orgId },
  (tx) => tx.select().from(mailLedger).where(eq(mailLedger.messageId, messageId)))).filter((x) => x.disposition !== "duplicate")[0];

const LETTER = (name: string) => `Dear Representative,

I am asking you to protect funding for rural health clinics in the coming budget. Clinics in our part of the state are the only place many families can see a doctor without driving more than an hour. Cutting the clinic grant program would close doors that will not reopen and push more people into emergency rooms that are already full.

Please vote NO on HB 142 and keep the rural clinic grants in the budget.

Sincerely,
${name}`;

describe("what a reading may set aside", () => {
  it("counts every signer of a form letter, whatever bulk marks the platform's mail carries", async () => {
    const o = await office();
    const via = (from: string, name: string, headers?: Record<string, string>) => receive(o.orgId,
      { from, name, replyTo: { address: `${name.toLowerCase().replace(" ", ".")}@mail.test`, name }, headers, body: LETTER(name) });
    const sent = [
      await receive(o.orgId, { from: "amy.adams@mail.test", name: "Amy Adams", body: LETTER("Amy Adams") }),
      await via("no-reply@votervoice.net", "Bob Brown"),
      await via("campaigns@p2a.co", "Cat Clark", { "list-unsubscribe": "<mailto:unsub@p2a.co>", "list-id": "<campaigns.p2a.co>" }),
      await via("advocacy@quorum.us", "Dan Diaz", { precedence: "bulk", "auto-submitted": "auto-generated" }),
      await via("actions@actionnetwork.org", "Eve Evans"),
    ];
    await classifyAll();

    for (const s of sent) {
      const m = await message(o.orgId, s.messageId);
      expect(m).toMatchObject({ triageStatus: "new", isAutomated: false, isSpam: false });
      expect(m.messageTypes[0]).toBe("constituent_policy");
      expect((await entry(o.orgId, s.messageId)).disposition).toBe("filed");
    }
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 5, positions: { oppose: 5 } });
    expect((await listFormLetters(o.ctx))[0]).toMatchObject({ people: 5, bill: "HB 142", stance: "oppose" });
  });

  it("sets a real mailing list aside, says so in the ledger, and keeps it once a person brings it back", async () => {
    const o = await office();
    const r = await receive(o.orgId, { from: "editor@paper.test", subject: "This week at the Capitol",
      body: "This week at the Capitol and what to expect next.", headers: { "list-id": "<weekly.paper.test>" } });
    await classifyAll();
    expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "archived", isAutomated: true });
    const row = await entry(o.orgId, r.messageId);
    expect(row.disposition).toBe("screened");
    expect(row.reason).toBe("Looks like a mailing list or automatic mail (List-Id header).");
    expect((await ledgerOverview(o.ctx)).byDisposition.screened).toBe(1);

    await restoreFromLedger(o.ctx, row.id);
    await classifyAll();
    await enqueue("message.classify", { messageId: r.messageId }, { orgId: o.orgId, idempotencyKey: `again:${r.messageId}` });
    await classifyAll();
    expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false });
    expect(await entry(o.orgId, r.messageId)).toMatchObject({ disposition: "filed", reason: "Restored by staff." });
    expect((await listInbox(o.ctx, {})).items.map((i) => i.id)).toContain(r.messageId);
  });

  it("keeps a mailing list a sender rule hid in view once it is brought back", async () => {
    const o = await office();
    await addSenderRule(o.ctx, { kind: "hide", value: "digest@lists.test" });
    const r = await receive(o.orgId,
      { from: "digest@lists.test", body: "The monthly digest of committee hearings and floor votes.", headers: { "list-id": "<digest.lists.test>" } });
    expect(r.disposition).toBe("hidden");

    await restoreFromLedger(o.ctx, (await entry(o.orgId, r.messageId)).id);
    await classifyAll();
    expect(await message(o.orgId, r.messageId)).toMatchObject({ triageStatus: "new", isAutomated: false });
    expect((await listInbox(o.ctx, {})).items.map((i) => i.id)).toContain(r.messageId);
  });

  it("does not let AI's opinion file a real letter as spam or a newsletter", async () => {
    const o = await office();
    const calls = fakeAi({ message_types: [{ type: "spam", confidence: 0.95 }, { type: "newsletter_automated", confidence: 0.95 }] });
    // "act now" gives the rules a weak spam reading for the model to push on.
    const r = await receive(o.orgId, { from: "fay.ford@mail.test", name: "Fay Ford", body: "Dear Representative, the hospital in our county is about to close. You need to act now. Please vote NO on HB 142 and help us keep it open. I also need help with my Medicaid application, which has been stuck for months.\n\nFay Ford" });
    await classifyAll();
    expect(calls).toHaveLength(1);

    const m = await message(o.orgId, r.messageId);
    expect(m).toMatchObject({ triageStatus: "new", isSpam: false, isAutomated: false });
    expect(m.messageTypes).not.toContain("newsletter_automated");
    expect((await entry(o.orgId, r.messageId)).disposition).toBe("filed");
    const waiting = await needsAPerson(o.ctx);
    expect([...waiting.urgent, ...waiting.casework].map((a) => a.messageId)).toContain(r.messageId);
    expect((await listInbox(o.ctx, {})).items.map((i) => i.id)).toContain(r.messageId);
  });

  it("lets AI bring a set-aside letter back for a person to look at", async () => {
    const o = await office();
    const calls = fakeAi({ message_types: [{ type: "constituent_policy", confidence: 0.9 }] });
    const r = await receive(o.orgId, { from: "maria@lopezbakery.test", name: "Maria Lopez", body: LETTER("Maria Lopez"),
      headers: { "list-unsubscribe": "<mailto:unsubscribe@sendtool.test>" } });
    await classifyAll();
    expect(calls).toHaveLength(1);

    const m = await message(o.orgId, r.messageId);
    expect(m).toMatchObject({ triageStatus: "new", isAutomated: false, requiresReview: true, messageTypes: ["constituent_policy"] });
    expect((await entry(o.orgId, r.messageId)).disposition).toBe("filed");
    const waiting = await withTenant({ orgId: o.orgId },
      (tx) => tx.select().from(reviewQueue).where(and(eq(reviewQueue.messageId, r.messageId), eq(reviewQueue.kind, "message_type"))));
    expect(waiting.map((w) => w.reason)).toEqual([BROUGHT_BACK]);
    expect(await billCorrespondence(o.ctx, "HB 142")).toMatchObject({ people: 1, positions: { oppose: 1 } });
  });

  it("keeps mail set aside when AI is unsure, calls it a newsletter, or fails, and counts each look", async () => {
    const o = await office();
    const newsletter = () => receive(o.orgId, { from: "editor@paper.test", subject: "This week at the Capitol",
      body: "This week at the Capitol and what to expect next.", headers: { "list-id": "<weekly.paper.test>" } });
    const stays = async (messageId: string) => {
      await classifyAll();
      expect(await message(o.orgId, messageId)).toMatchObject({ triageStatus: "archived", isAutomated: true, requiresReview: false });
      expect((await entry(o.orgId, messageId)).disposition).toBe("screened");
    };

    fakeAi({ message_types: [{ type: "constituent_policy", confidence: 0.6 }] });
    await stays((await newsletter()).messageId);
    fakeAi({ message_types: [{ type: "constituent_policy", confidence: 0.8 }, { type: "newsletter_automated", confidence: 0.9 }] });
    await stays((await newsletter()).messageId);
    expect((await setupStatus(o.ctx)).aiUsedToday).toBe(2);

    setAiProviderForTests({ model: "fake", classify: async () => null, generate: async () => null });
    await stays((await newsletter()).messageId);
    expect((await setupStatus(o.ctx)).aiUsedToday).toBe(2);

    // Staff mail the rules set aside is never sent for a second look.
    const calls = fakeAi({ message_types: [{ type: "constituent_policy", confidence: 0.95 }] });
    await receive(o.orgId, { from: "aide@house.example.gov", body: "Can you pull the HB 142 correspondence before Tuesday?" });
    await classifyAll();
    expect(calls).toHaveLength(0);
  });
});
