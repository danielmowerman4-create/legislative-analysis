import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { systemDb, withTenant } from "@/server/db/client";
import { billAlertRules, bills, legislativeEvents, notifications, whipEntries } from "@/server/db/schema";
import { FixtureProvider, registerFixtureProvider } from "@/server/legislation/providers/fixture";
import { demoLegislativeDataset, DEMO_SESSIONS } from "@/server/demo/legislative-fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { matchAlertRules } from "@/server/legislation/alerts";
import { isPassageVote, voteOutcome } from "@/server/legislation/scoring";
import { getBillDetail, setBillPosition, todayBriefing, trackBills, updateTracking } from "@/server/services/legislation";
import { addAlertRule, deleteAlertRule, hearingPrep, listAlertRules, scorecards, setAlertRuleActive, setWhipStance, whipBoard } from "@/server/services/tools";
import { votesNeeded } from "@/lib/whip";

const dataset = demoLegislativeDataset();
const provider = new FixtureProvider(dataset);
afterAll(() => registerFixtureProvider(null));

async function billId(providerBillId: string) {
  const db = await systemDb();
  const [row] = await db.select({ id: bills.id }).from(bills).where(eq(bills.providerBillId, providerBillId));
  return row.id;
}

describe("office tools", () => {
  let office: Awaited<ReturnType<typeof makeOffice>>;
  let other: Awaited<ReturnType<typeof makeOffice>>;
  let hb142: string;
  beforeAll(async () => {
    await freshDatabase();
    registerFixtureProvider(provider);
    office = await makeOffice({ jurisdictionCode: "ZZ" });
    other = await makeOffice({ jurisdictionCode: "ZZ" });
    await syncJurisdiction("ZZ", { provider, sessionIdentifiers: DEMO_SESSIONS().map((s) => s.identifier) });
    hb142 = await billId("zz-hb142");
  });

  it("counts the votes needed against every seat", () => {
    expect(votesNeeded(180, "majority")).toBe(91);
    expect(votesNeeded(56, "majority")).toBe(29);
    expect(votesNeeded(180, "two_thirds")).toBe(120);
    expect(votesNeeded(56, "two_thirds")).toBe(38);
  });

  it("starts the whip board from recorded votes and sponsors", async () => {
    const house = await whipBoard(office.ctx, hb142, { chamber: "lower" });
    expect(house.seats).toBe(180);
    const yes = house.rows.filter((r) => r.stance === "yes");
    expect(yes.length).toBeGreaterThan(0);
    expect(yes.every((r) => /^(Voted yes|Lead sponsor|Co-sponsor)/.test(r.basis ?? ""))).toBe(true);
    // HB 142 has passed the House, so the board defaults to the Senate floor.
    const next = await whipBoard(office.ctx, hb142);
    expect(next.chamber).toBe("upper");
  });

  it("lets an office override a member, clear it, and keeps it from other offices", async () => {
    const before = (await whipBoard(office.ctx, hb142, { chamber: "upper" })).rows[0];
    await setWhipStance(office.ctx, hb142, before.id, "lean_no", "Heard concerns about the formula");
    const set = (await whipBoard(office.ctx, hb142, { chamber: "upper" })).rows.find((r) => r.id === before.id)!;
    expect([set.stance, set.officeSet, set.basis, set.note]).toEqual(["lean_no", true, "Set by your office", "Heard concerns about the formula"]);

    const seenByOther = (await whipBoard(other.ctx, hb142, { chamber: "upper" })).rows.find((r) => r.id === before.id)!;
    expect(seenByOther.officeSet).toBe(false);
    const rows = await withTenant({ orgId: other.orgId }, (tx) => tx.select().from(whipEntries));
    expect(rows).toHaveLength(0);

    await setWhipStance(office.ctx, hb142, before.id, null);
    const cleared = (await whipBoard(office.ctx, hb142, { chamber: "upper" })).rows.find((r) => r.id === before.id)!;
    expect([cleared.stance, cleared.officeSet]).toEqual([before.autoStance, false]);
  });

  it("scores recorded passage votes against the office's positions", async () => {
    expect(isPassageVote("House third reading")).toBe(true);
    expect(isPassageVote("House Education Committee: do pass by substitute")).toBe(true);
    expect(isPassageVote("Floor amendment 2")).toBe(false);
    expect(isPassageVote("Motion to table")).toBe(false);
    expect(voteOutcome("support", "yes")).toBe("with");
    expect(voteOutcome("oppose", "yes")).toBe("against");
    expect(voteOutcome("oppose", "no")).toBe("with");
    expect(voteOutcome("support", "not_voting")).toBe("missed");
    expect(voteOutcome("watching", "yes")).toBeNull();

    expect((await scorecards(office.ctx)).rows).toHaveLength(0);
    await trackBills(office.ctx, [hb142], { position: "support", priority: "high", reason: "Test" });
    const card = await scorecards(office.ctx);
    expect(card.rollCalls).toBeGreaterThan(0);
    const voted = card.rows.filter((r) => r.counted > 0);
    expect(voted.length).toBeGreaterThan(0);
    for (const r of voted) expect(r.with + r.against).toBe(r.counted);
    // One bill means at most a couple of votes each, too few for a percentage.
    expect(card.rows.filter((r) => r.counted < 3).every((r) => r.score === null)).toBe(true);
    expect((await scorecards(other.ctx)).rows).toHaveLength(0);
  });

  it("builds a prep sheet with tracked bills first", async () => {
    const db = await systemDb();
    const events = await db.select({ id: legislativeEvents.id, billIds: legislativeEvents.billIds }).from(legislativeEvents);
    const withBill = events.find((e) => e.billIds.includes(hb142) && e.billIds.length > 1)!;
    const prep = await hearingPrep(office.ctx, withBill.id);
    expect(prep.items).toHaveLength(withBill.billIds.length);
    expect(prep.items[0].bill.id).toBe(hb142);
    expect(prep.items[0].tracking?.position).toBe("support");
  });

  it("notifies once for bills filed after an alert was set, and only that office", async () => {
    await addAlertRule(office.ctx, "keyword", "literacy");
    const db = await systemDb();
    const hits = () => withTenant({ orgId: office.orgId }, (tx) => tx.select().from(notifications).where(eq(notifications.sourceType, "bill_alert_rule")));

    expect((await matchAlertRules("ZZ")).notifications).toBe(0);

    await db.update(billAlertRules).set({ createdAt: new Date("2020-01-01") }).where(eq(billAlertRules.organizationId, office.orgId));
    const first = await matchAlertRules("ZZ");
    expect(first.notifications).toBeGreaterThan(0);
    expect((await hits()).every((n) => n.link?.startsWith("/bills/") && n.title.includes("matches your alert"))).toBe(true);
    expect((await matchAlertRules("ZZ")).notifications).toBe(0);

    const [rule] = await listAlertRules(office.ctx);
    expect(rule.filedSince).toBe(first.notifications);
    expect(rule.total).toBeGreaterThan(0);
    expect(await listAlertRules(other.ctx)).toHaveLength(0);

    await setAlertRuleActive(office.ctx, rule.id, false);
    await db.delete(notifications).where(and(eq(notifications.organizationId, office.orgId), eq(notifications.sourceType, "bill_alert_rule")));
    expect((await matchAlertRules("ZZ")).notifications).toBe(0);
    await deleteAlertRule(office.ctx, rule.id);
    expect(await listAlertRules(office.ctx)).toHaveLength(0);
  });

  it("rejects a malformed code section", async () => {
    await expect(addAlertRule(office.ctx, "code", "chapter two")).rejects.toThrow(/code section/i);
    await addAlertRule(office.ctx, "code", "§ 20-2-161");
    const [rule] = await listAlertRules(office.ctx);
    expect(rule.value).toBe("20-2-161");
  });

  it("records a position in one click, tracking the bill and keeping its reason", async () => {
    const id = await billId("zz-hb615");
    await setBillPosition(office.ctx, id, "oppose");
    expect((await getBillDetail(office.ctx, id)).tracking).toMatchObject({ position: "oppose", priority: "normal" });
    await updateTracking(office.ctx, id, { reason: "District concern" });
    await setBillPosition(office.ctx, id, "support");
    expect((await getBillDetail(office.ctx, id)).tracking).toMatchObject({ position: "support", reason: "District concern" });
    expect((await getBillDetail(other.ctx, id)).tracking).toBeNull();
  });

  it("assigns a bill only to the office's own staff and shows the follow-up on Today", async () => {
    const id = await billId("zz-hb615");
    await expect(updateTracking(office.ctx, id, { assignedTo: other.ctx.userId })).rejects.toThrow(/not on this office/);
    await expect(updateTracking(office.ctx, id, { dueDate: "soon" })).rejects.toThrow(/full date/);
    await updateTracking(office.ctx, id, { assignedTo: office.ctx.userId, nextStep: "Call the lead sponsor", dueDate: "2026-12-01" });
    const brief = await todayBriefing(office.ctx);
    expect(brief.followUps).toEqual([expect.objectContaining({ id, nextStep: "Call the lead sponsor", dueDate: "2026-12-01", assignedTo: office.ctx.userId })]);
    expect((await todayBriefing(other.ctx)).followUps).toEqual([]);
  });
});
