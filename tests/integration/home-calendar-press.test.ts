import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { withTenant } from "@/server/db/client";
import { bills, officeEvents, pressItems } from "@/server/db/schema";
import { drainJobs } from "@/server/jobs/runner";
import { setAiProviderForTests, type AiProvider } from "@/server/ai/provider";
import { DEMO_SESSIONS, demoLegislativeDataset } from "@/server/demo/legislative-fixture";
import { FixtureProvider } from "@/server/legislation/providers/fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { addOfficeEvent, deleteOfficeEvent, hasUpcomingOwn, officeCalendar, updateOfficeEvent } from "@/server/services/calendar";
import { billCorrespondence, enableConstituentCenter, mailByWeek, setAiProcessing } from "@/server/services/center";
import { listInbox } from "@/server/services/inbox";
import { trackBills } from "@/server/services/legislation";
import { addMember } from "@/server/services/offices";
import { approvePress, createPress, deletePress, getPress, listPress, OWN_WORDS, savePressGraphic, updatePress } from "@/server/services/press";

async function office() {
  const o = await makeOffice();
  await enableConstituentCenter(o.orgId);
  return o;
}

const member = async (o: Awaited<ReturnType<typeof office>>, roleKey: Parameters<typeof addMember>[1]["roleKey"]) =>
  contextFor(await addMember(o.ctx, { email: `${roleKey}-${o.orgId}@example.test`, name: roleKey, roleKey, password: "correct horse battery staple" }), o.orgId);
const classifyAll = () => drainJobs(["classify"]);
const billNamed = async (orgId: string, identifier: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(bills).where(eq(bills.identifier, identifier))))[0];
const twoWeeks = () => ({ from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 14 * 86400_000) });
const dayFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await freshDatabase();
  await syncJurisdiction("ZZ", { provider: new FixtureProvider(demoLegislativeDataset()), sessionIdentifiers: DEMO_SESSIONS().map((x) => x.identifier) });
});

afterEach(() => setAiProviderForTests(undefined));

describe("mail sorted by stance", () => {
  it("filters the mail by the side each letter takes on a bill and shows that side on the row", async () => {
    const o = await office();
    const yes = await receive(o.orgId, { from: "ann@mail.test", name: "Ann Lee", body: "I support HB 142. Please vote yes on HB 142." });
    const no = await receive(o.orgId, { from: "ben@mail.test", name: "Ben Ortiz", body: "I oppose HB 142. Please vote no on HB 142." });
    const ask = await receive(o.orgId, { from: "cal@mail.test", name: "Cal Reed", body: "What is the status of HB 142, and when will the committee vote on it?" });
    await receive(o.orgId, { from: "dee@mail.test", name: "Dee Park", body: "Thank you for coming to the fair on Saturday." });
    await classifyAll();

    const ids = async (stance?: "support" | "oppose" | "neutral" | "mixed" | "unclear") => (await listInbox(o.ctx, { stance })).items.map((m) => m.id);
    expect(await ids("support")).toEqual([yes.messageId]);
    expect(await ids("oppose")).toEqual([no.messageId]);
    expect(await ids("neutral")).toEqual([ask.messageId]);
    expect(await ids("mixed")).toEqual([]);
    expect(await ids()).toHaveLength(4);
    const row = (await listInbox(o.ctx, {})).items.find((m) => m.id === no.messageId)!;
    expect(row.bills).toEqual([expect.objectContaining({ reference: "HB 142", stance: "oppose" })]);
  });

  it("narrows a bill's letters to one side and counts people by week", async () => {
    const o = await office();
    const old = new Date(Date.now() - 21 * 86400_000);
    await receive(o.orgId, { from: "ann@mail.test", name: "Ann Lee", body: "I support HB 142. Please vote yes on HB 142.", at: old });
    await receive(o.orgId, { from: "ben@mail.test", name: "Ben Ortiz", body: "I oppose HB 142. Please vote no on HB 142." });
    await receive(o.orgId, { from: "cal@mail.test", name: "Cal Reed", body: "I oppose HB 142. It should not pass." });
    await classifyAll();

    const all = await billCorrespondence(o.ctx, "HB 142");
    expect(all.people).toBe(3);
    expect(all.positions).toMatchObject({ support: 1, oppose: 2 });
    expect((await billCorrespondence(o.ctx, "HB 142", { side: "support" })).letters.map((l) => l.name)).toEqual(["Ann Lee"]);
    expect((await billCorrespondence(o.ctx, "HB 142", { side: "oppose" })).letters.map((l) => l.name).sort()).toEqual(["Ben Ortiz", "Cal Reed"]);
    expect((await billCorrespondence(o.ctx, "HB 142", { side: "other" })).letters).toEqual([]);

    // Every week from the first letter to the last is a column, the empty ones too.
    expect(all.weeks.length).toBeGreaterThanOrEqual(3);
    expect(all.weeks[0]).toMatchObject({ support: 1, oppose: 0 });
    expect(all.weeks[all.weeks.length - 1]).toMatchObject({ support: 0, oppose: 2 });
    expect(all.weeks.reduce((t, w) => t + w.support + w.oppose + w.other, 0)).toBe(3);
    const office_ = await mailByWeek(o.ctx);
    expect(office_.reduce((t, w) => t + w.support + w.oppose + w.other, 0)).toBe(3);
    expect(office_.reduce((t, w) => t + w.oppose, 0)).toBe(2);
  });
});

describe("the office's own calendar", () => {
  it("keeps the office's entries beside hearings on tracked bills, and leaves other hearings to All hearings", async () => {
    const o = await office();
    const everything = await officeCalendar(o.ctx, { ...twoWeeks(), scope: "all" });
    expect(everything.hearings.length).toBeGreaterThan(0);
    expect((await officeCalendar(o.ctx, { ...twoWeeks(), scope: "mine" })).hearings).toEqual([]);

    // The demo schedules a Senate hearing on HB 142 three days out.
    const hb142 = await billNamed(o.orgId, "HB 142");
    await trackBills(o.ctx, [hb142.id], { position: "support", priority: "normal", reason: null });
    const id = await addOfficeEvent(o.ctx, { title: "  Rotary lunch ", date: dayFromNow(2), time: "12:30", location: "Elks Lodge", note: "Bring the road map" });
    const allDay = await addOfficeEvent(o.ctx, { title: "District office closed", date: dayFromNow(5) });

    const mine = await officeCalendar(o.ctx, { ...twoWeeks(), scope: "mine" });
    expect(mine.hearings.length).toBeGreaterThan(0);
    expect(mine.hearings.every((e) => e.bills.some((b) => b.identifier === "HB 142"))).toBe(true);
    expect(mine.hearings.length).toBeLessThan(everything.hearings.length);
    expect(mine.own.map((e) => [e.title, e.allDay, e.location])).toEqual([["Rotary lunch", false, "Elks Lodge"], ["District office closed", true, null]]);
    expect(await hasUpcomingOwn(o.ctx)).toBe(true);

    await updateOfficeEvent(o.ctx, id, { title: "Rotary lunch", date: dayFromNow(3), time: "", location: "", note: "" });
    await deleteOfficeEvent(o.ctx, allDay);
    const after = await officeCalendar(o.ctx, { ...twoWeeks(), scope: "mine" });
    expect(after.own.map((e) => [e.title, e.allDay, e.location, e.note])).toEqual([["Rotary lunch", true, null, null]]);
  });

  it("refuses a nameless entry, a bad time, a viewer, and another office", async () => {
    const o = await office();
    const other = await office();
    await expect(addOfficeEvent(o.ctx, { title: " ", date: dayFromNow(1) })).rejects.toThrow(/name/);
    await expect(addOfficeEvent(o.ctx, { title: "Coffee", date: dayFromNow(1), time: "25:00" })).rejects.toThrow(/time/);
    await expect(addOfficeEvent(o.ctx, { title: "Coffee", date: "soon" })).rejects.toThrow(/date/);
    await expect(addOfficeEvent(await member(o, "viewer"), { title: "Coffee", date: dayFromNow(1) })).rejects.toThrow();

    const id = await addOfficeEvent(o.ctx, { title: "Coffee with the mayor", date: dayFromNow(1), time: "9:00" });
    expect((await officeCalendar(other.ctx, { ...twoWeeks(), scope: "mine" })).own).toEqual([]);
    await expect(updateOfficeEvent(other.ctx, id, { title: "Taken", date: dayFromNow(1) })).rejects.toThrow(/gone/);
    await deleteOfficeEvent(other.ctx, id);
    expect(await withTenant({ orgId: o.orgId }, (tx) => tx.select({ title: officeEvents.title }).from(officeEvents))).toEqual([{ title: "Coffee with the mayor" }]);
  });
});

describe("press statements", () => {
  it("drafts from the bill's record with the office's words, and is approved only once nothing is left in brackets", async () => {
    const o = await office();
    const hb142 = await billNamed(o.orgId, "HB 142");
    await trackBills(o.ctx, [hb142.id], { position: "support", priority: "normal", reason: null });

    const id = await createPress(o.ctx, { kind: "bill", billId: hb142.id, words: "Our schools have waited long enough for a fair formula." });
    const p = await getPress(o.ctx, id);
    expect(p).toMatchObject({ kind: "bill", status: "draft", aiGenerated: false, headline: "Rep. Test on HB 142" });
    expect(p.body).toContain("FOR IMMEDIATE RELEASE");
    expect(p.body).toContain('"Our schools have waited long enough for a fair formula."');
    expect(p.body).toMatch(/HB 142, School Funding Formula Revision Act, has passed one chamber\. Its most recent action, on [A-Z][a-z]+ \d{1,2}, \d{4}: /);
    expect(p.body).toContain("Rep. Test supports HB 142.");
    expect(p.bill).toMatchObject({ identifier: "HB 142" });

    await expect(approvePress(o.ctx, id)).rejects.toThrow(/brackets/);
    await updatePress(o.ctx, id, { headline: "Kennedy backs school funding bill", body: p.body.replace(/Contact: \[[^\]]+\]/, "Contact: Pat Jones, 555-0100") });
    await approvePress(o.ctx, id);
    expect(await getPress(o.ctx, id)).toMatchObject({ status: "approved", headline: "Kennedy backs school funding bill" });
    expect(await listPress(o.ctx)).toEqual([expect.objectContaining({ id, status: "approved", bill: "HB 142" })]);

    // An edit after approval puts it back to a draft.
    await updatePress(o.ctx, id, { headline: "Kennedy backs school funding bill", body: "Changed." });
    expect(await getPress(o.ctx, id)).toMatchObject({ status: "draft", approvedBy: null, approvedAt: null });
  });

  it("leaves a place for the legislator's words when none are given, and needs a bill or a subject", async () => {
    const o = await office();
    await expect(createPress(o.ctx, { kind: "statement" })).rejects.toThrow(/about/);
    const p = await getPress(o.ctx, await createPress(o.ctx, { kind: "event", about: "the Route 9 bridge reopening" }));
    expect(p.headline).toBe("Rep. Test on the Route 9 bridge reopening");
    expect(p.body).toContain(`"${OWN_WORDS}"`);
    expect(p.bill).toBeNull();
  });

  it("lets AI shape only the office's notes, with identifiers masked, and marks the draft", async () => {
    const o = await office();
    await setAiProcessing(o.ctx, true);
    let seen = "";
    setAiProviderForTests({
      model: "stand-in", classify: async () => null,
      generate: async (i) => {
        seen = i.sources.map((s) => s.text).join("\n");
        return { text: 'Our "schools" cannot wait. [source:notes]', citedIds: ["notes"] };
      },
    } as AiProvider);
    const p = await getPress(o.ctx, await createPress(o.ctx, { kind: "statement", about: "school funding", words: "schools cannot wait, my SSN is 123-45-6789" }));
    expect(seen).toContain("[SSN]");
    expect(seen).not.toContain("123-45-6789");
    expect(p.aiGenerated).toBe(true);
    expect(p.body).toContain('"Our schools cannot wait."');
  });

  it("keeps drafting to staff who may draft, each office to its own statements, and refuses a bad color", async () => {
    const o = await office();
    const other = await office();
    await expect(createPress(await member(o, "viewer"), { kind: "statement", about: "roads" })).rejects.toThrow();
    const id = await createPress(o.ctx, { kind: "statement", about: "roads" });
    await expect(getPress(other.ctx, id)).rejects.toThrow(/not found/i);
    expect(await listPress(other.ctx)).toEqual([]);

    const graphic = { layout: "wash", size: "portrait", headline: "Fix Route 9", statement: "It has waited long enough.", kicker: "PAT TEST\nDistrict 1",
      field: "#14264a", accent: "#b3282d" } as const;
    await expect(savePressGraphic(o.ctx, id, { ...graphic, accent: "red" })).rejects.toThrow(/color/);
    await savePressGraphic(o.ctx, id, graphic);
    expect((await getPress(o.ctx, id)).graphic).toEqual(graphic);

    await deletePress(other.ctx, id);
    expect(await withTenant({ orgId: o.orgId }, (tx) => tx.select({ id: pressItems.id }).from(pressItems))).toHaveLength(1);
    await deletePress(o.ctx, id);
    expect(await listPress(o.ctx)).toEqual([]);
  });
});
