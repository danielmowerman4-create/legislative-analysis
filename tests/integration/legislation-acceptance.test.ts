import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { systemDb, withTenant } from "@/server/db/client";
import { billActions, bills, billStatusHistory, notifications, trackedBills } from "@/server/db/schema";
import { FixtureProvider, registerFixtureProvider } from "@/server/legislation/providers/fixture";
import { demoLegislativeDataset, DEMO_SESSIONS } from "@/server/demo/legislative-fixture";
import { syncJurisdiction } from "@/server/legislation/sync";
import { drainJobs } from "@/server/jobs/runner";
import { compareBills, compareBillVersions, getBillDetail, linkBills, listBills, listLegislators, relatedBills, setTracked, trackBills,
  unlinkBills } from "@/server/services/legislation";
import { classifyAction } from "@/server/legislation/normalize";
import { billStages, sponsorSpectrum } from "@/server/legislation/stages";
import { extractCodeSections, reasonText } from "@/server/legislation/related";

const dataset = demoLegislativeDataset();
const provider = new FixtureProvider(dataset);

afterAll(() => registerFixtureProvider(null));

async function billId(providerBillId: string) {
  const db = await systemDb();
  const [row] = await db.select({ id: bills.id }).from(bills).where(eq(bills.providerBillId, providerBillId));
  return row.id;
}

describe("legislation acceptance", () => {
  let office: Awaited<ReturnType<typeof makeOffice>>;
  beforeAll(async () => {
    await freshDatabase();
    registerFixtureProvider(provider);
    office = await makeOffice({ jurisdictionCode: "ZZ" });
    const r = await syncJurisdiction("ZZ", { provider, sessionIdentifiers: DEMO_SESSIONS().map((s) => s.identifier) });
    expect(r.status).toBe("succeeded");
    expect(r.billsChanged).toBe(dataset.bills.length);
  });

  it("stores bills with sessions, actions, sponsors with party, versions and hearings", async () => {
    const detail = await getBillDetail(office.ctx, await billId("zz-hb142"));
    expect(detail.bill.title).toBe("School Funding Formula Revision Act");
    expect(detail.session.identifier).toBe("2025-2026");
    expect(detail.actions.length).toBe(6);
    expect(detail.sponsors.map((s) => [s.name, s.party, s.district])).toEqual([
      ["Dana Whitfield", "D", "58"],
      ["Marcus Bell", "R", "112"],
      ["Jordan Ellis", "D", "42"],
    ]);
    expect(sponsorSpectrum(detail.sponsors.map((s) => s.party))).toBe("Bipartisan (2 D, 1 R)");
    expect(detail.versions.filter((v) => v.hasText)).toHaveLength(2);
    expect(detail.bill.codeSections).toEqual(["20-2", "20-2-161"]);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0].billIds.sort()).toEqual([await billId("zz-hb142"), await billId("zz-sb151")].sort());
  });

  it("records member votes that add up to each floor roll call, and none for committee votes", async () => {
    const detail = await getBillDetail(office.ctx, await billId("zz-hb142"));
    const floor = detail.votes.find((v) => v.motion === "House third reading")!;
    expect(floor.members).toHaveLength(180);
    expect(floor.members.filter((m) => m.vote === "yes")).toHaveLength(floor.yes);
    expect(floor.members.filter((m) => m.vote === "no")).toHaveLength(floor.no);
    expect(floor.members.filter((m) => m.vote === "not_voting")).toHaveLength(floor.other);
    expect(floor.members.every((m) => m.party === "R" || m.party === "D")).toBe(true);
    expect(detail.votes.find((v) => /committee/i.test(v.motion))!.members).toHaveLength(0);
  });

  it("shows where a bill stands, with dates traced to its actions", async () => {
    const enacted = await getBillDetail(office.ctx, await billId("zz-hb77"));
    const e = billStages(enacted.bill, enacted.actions);
    expect(e.outcome).toBeNull();
    expect(e.stages.map((s) => s.state)).toEqual(Array(7).fill("done"));
    expect(e.stages.find((s) => s.key === "law")!.date).toBe(enacted.actions.find((a) => a.description.startsWith("Signed"))!.actionDate);

    const failed = await getBillDetail(office.ctx, await billId("zz-sb18"));
    const f = billStages(failed.bill, failed.actions);
    expect(f.outcome?.kind).toBe("failed");
    expect(f.stages.map((s) => [s.label, s.state])).toEqual([
      ["Introduced", "done"],
      ["Senate committee", "done"],
      ["Passed Senate", "stopped"],
      ["House committee", "upcoming"],
      ["Passed House", "upcoming"],
      ["Governor", "upcoming"],
      ["Law", "upcoming"],
    ]);

    const resolution = await getBillDetail(office.ctx, await billId("zz-hr44"));
    expect(billStages(resolution.bill, resolution.actions).stages.map((s) => s.label)).toEqual(["Introduced", "House committee", "Adopted"]);
  });

  it("connects bills: companions, earlier sessions, the same code section, source links and staff links", async () => {
    const reasonsOf = async (from: string, to: string) => {
      const rows = await relatedBills(office.ctx, await billId(from));
      return rows.find((r) => r.identifier === to)?.reasons.map((r) => r.kind) ?? [];
    };
    expect(await reasonsOf("zz-hb142", "SB 151")).toEqual(expect.arrayContaining(["source", "companion", "code"]));
    expect(await reasonsOf("zz-hb230", "HB 905")).toEqual(expect.arrayContaining(["earlier_session", "code"]));
    expect(await reasonsOf("zz-hb905-2024", "HB 230")).toContain("later_session");
    expect(await reasonsOf("zz-hb77", "HB 321")).toContain("earlier_session");
    expect(await reasonsOf("zz-sb40", "HB 388")).toContain("code");
    expect(await reasonsOf("zz-hb412", "SB 205")).toContain("code");

    const hb412 = (await relatedBills(office.ctx, await billId("zz-hb412"))).find((r) => r.identifier === "SB 205")!;
    expect(hb412.group).toBe("code");
    expect(reasonText(hb412.reasons.find((r) => r.kind === "code")!)).toBe("Both change § 20-2-153");

    const broadband = (await relatedBills(office.ctx, await billId("zz-hb501"))).find((r) => r.identifier === "SB 99")!;
    expect(reasonText(broadband.reasons.find((r) => r.kind === "code")!)).toBe("Both change Title 50, Chapter 8");

    const hb142 = await relatedBills(office.ctx, await billId("zz-hb142"));
    expect(hb142.find((r) => r.identifier === "HB 95")).toBeUndefined();

    await linkBills(office.ctx, await billId("zz-hb310"), await billId("zz-sb112"), "Both fund transportation");
    const linked = (await relatedBills(office.ctx, await billId("zz-sb112"))).find((r) => r.identifier === "HB 310")!;
    expect(linked.reasons[0]).toEqual({ kind: "office", note: "Both fund transportation" });
    expect(linked.group).toBe("connected");
    await unlinkBills(office.ctx, await billId("zz-sb112"), await billId("zz-hb310"));
    const after = (await relatedBills(office.ctx, await billId("zz-sb112"))).find((r) => r.identifier === "HB 310");
    expect(after?.reasons.map((r) => r.kind)).toEqual(["subject"]);
  });

  it("compares the text of two different bills", async () => {
    const r = await compareBills(office.ctx, { billId: await billId("zz-hb142") }, { billId: await billId("zz-sb151") });
    expect(r.left.version!.label).toBe("House Committee Substitute");
    expect(r.right.version!.label).toBe("Introduced");
    const c = r.comparison!;
    expect(c.sections.find((s) => s.label === "Section 3")!.amounts).toEqual({ before: ["$6,350", "$250"], after: ["$6,200", "$300"] });
    expect(c.sections.find((s) => s.label === "Section 6")!.status).toBe("removed");
    expect(c.sections.find((s) => s.label === "Section 1")!.status).toBe("unchanged");
  });

  it("tracks a bill and its companion with one position and priority", async () => {
    await trackBills(office.ctx, [await billId("zz-hb142"), await billId("zz-sb151")],
      { position: "support", priority: "high", reason: "School funding", note: "Testify at the Senate hearing." });
    const rows = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(trackedBills));
    expect(rows.map((r) => [r.position, r.priority])).toEqual([
      ["support", "high"],
      ["support", "high"],
    ]);
    const detail = await getBillDetail(office.ctx, await billId("zz-sb151"));
    expect(detail.tracking?.position).toBe("support");
    expect(detail.notes[0].body).toBe("Testify at the Senate hearing.");
  });

  it("counts filtered views correctly and lists legislators with their sponsorship counts", async () => {
    const tracked = await listBills(office.ctx, { view: "tracked" });
    expect(tracked.items.length).toBeGreaterThan(0);
    expect(tracked.total).toBe(tracked.items.length);
    const byCode = await listBills(office.ctx, { code: "20-2-153" });
    expect(byCode.items.map((b) => b.identifier).sort()).toEqual(["HB 412", "SB 205"]);
    expect(byCode.total).toBe(2);
    const sponsor = await listBills(office.ctx, { q: "Whitfield" });
    expect(sponsor.total).toBe(sponsor.items.length);
    expect(sponsor.items.map((b) => b.identifier)).toContain("HB 142");
    const senate = await listLegislators(office.ctx, { chamber: "upper" });
    expect(senate).toHaveLength(56);
    expect(senate.find((l) => l.name === "Ana Morales")).toMatchObject({ party: "D", district: "35", authored: 2 });
  });

  it("a new action on a tracked bill updates the record, preserves history and notifies the office", async () => {
    const id = await billId("zz-sb40");
    await setTracked(office.ctx, id, true);
    const bill = provider.data.bills.find((b) => b.providerBillId === "zz-sb40")!;
    const desc = "Third reading passed (41-12)";
    bill.actions.push({ providerKey: "zz-sb40-a-new", date: new Date().toISOString().slice(0, 10), chamber: "upper", description: desc,
      classification: classifyAction(desc) });
    bill.status = "passed_chamber";
    bill.lastActionText = desc;
    bill.lastActionAt = new Date().toISOString().slice(0, 10);

    const r = await syncJurisdiction("ZZ", { provider });
    expect(r.billsChanged).toBe(1);
    expect(r.actionsAdded).toBe(1);
    await drainJobs(); // runs legislation.alerts

    const db = await systemDb();
    const [b] = await db.select().from(bills).where(eq(bills.id, id));
    expect(b.status).toBe("passed_chamber");
    const actions = await db.select().from(billActions).where(eq(billActions.billId, id));
    expect(actions).toHaveLength(4); // nothing overwritten, one appended
    const history = await db.select().from(billStatusHistory).where(eq(billStatusHistory.billId, id));
    expect(history.map((h) => `${h.fromStatus}->${h.toStatus}`)).toContain("in_committee->passed_chamber");
    const notes = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(notifications).where(eq(notifications.organizationId, office.orgId)));
    const alert = notes.find((n) => n.title.startsWith("SB 40"))!;
    expect(alert.title).toBe("SB 40: Passed");
    expect(alert.link).toBe(`/bills/${id}`);

    const again = await syncJurisdiction("ZZ", { provider });
    expect(again.billsChanged).toBe(0);
    await drainJobs();
    const notes2 = await withTenant({ orgId: office.orgId }, (tx) => tx.select().from(notifications).where(eq(notifications.organizationId, office.orgId)));
    expect(notes2.length).toBe(notes.length);
  });

  it("compares bill versions section by section and tags definitions, appropriations and dates", async () => {
    const id = await billId("zz-hb142");
    const detail = await getBillDetail(office.ctx, id);
    const [v1, v2] = detail.versions;
    const r = await compareBillVersions(office.ctx, id, v1.id, v2.id);
    const c = r.comparison!;
    const s2 = c.sections.find((s) => s.label === "Section 2")!;
    const s3 = c.sections.find((s) => s.label === "Section 3")!;
    const s4 = c.sections.find((s) => s.label === "Section 4")!;
    const s5 = c.sections.find((s) => s.label === "Section 5")!;
    expect(s2.tags).toContain("definitions");
    expect(s3.amounts.after).toEqual(["$6,350", "$250"]);
    expect(s4.tags).toContain("appropriations");
    expect(s5.dates).toEqual({ before: ["July 1, 2026"], after: ["July 1, 2027"] });
    expect(c.sections.find((s) => s.label === "Section 6")!.status).toBe("added");
    expect(c.sections.find((s) => s.label === "Section 1")!.status).toBe("unchanged");
  });
});

describe("code citations", () => {
  it("finds sections and chapters in Georgia-style titles and ignores dates and phone numbers", () => {
    expect(
      extractCodeSections(
        "A BILL to amend Code Sections 16-11-125.1 and 16-11-129 of the Official Code of Georgia Annotated; to amend Article 1 of Chapter 10 of Title 15; effective July 1, 2026; call 404-555-1234 or see 2026-03-19.",
      ),
    ).toEqual(["15-10", "16-11", "16-11-125.1", "16-11-129"]);
  });
});
