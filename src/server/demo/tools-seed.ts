import { and, asc, eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { billAlertRules, bills, legislators, organizations, trackedBills, whipEntries } from "../db/schema";
import { matchAlertRules } from "../legislation/alerts";

export async function seedDemoTools() {
  const db = await systemDb();
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, "demo-office"));
  if (!org) return;

  const haveRules = await db.select({ id: billAlertRules.id }).from(billAlertRules).where(eq(billAlertRules.organizationId, org.id)).limit(1);
  if (!haveRules.length) {
    // Offices seeded before scorecards: bills with floor votes need a position.
    const positions: [string, "support" | "oppose"][] = [["zz-hb128", "support"], ["zz-hb95", "oppose"], ["zz-sb205", "support"]];
    for (const [pid, position] of positions) {
      const [b] = await db.select({ id: bills.id }).from(bills).where(eq(bills.providerBillId, pid));
      if (b) await db.update(trackedBills).set({ position }).where(and(eq(trackedBills.organizationId, org.id), eq(trackedBills.billId, b.id)));
    }
    // Backdated so the demo bills count as filed after this alert.
    await db.insert(billAlertRules).values({ organizationId: org.id, kind: "keyword", value: "literacy", createdAt: new Date("2025-01-01T12:00:00Z") });
    await db.insert(billAlertRules).values([
      { organizationId: org.id, kind: "code", value: "20-2" },
      { organizationId: org.id, kind: "sponsor", value: "Whitfield" },
    ]);
    await matchAlertRules("ZZ");
  }

  const [bill] = await db.select({ id: bills.id }).from(bills).where(eq(bills.providerBillId, "zz-hb142"));
  if (!bill) return;
  const haveWhip = await db
    .select({ id: whipEntries.id })
    .from(whipEntries)
    .where(and(eq(whipEntries.organizationId, org.id), eq(whipEntries.billId, bill.id)))
    .limit(1);
  if (haveWhip.length) return;
  const senate = await db
    .select({ id: legislators.id, party: legislators.party })
    .from(legislators)
    .where(and(eq(legislators.jurisdictionCode, "ZZ"), eq(legislators.chamber, "upper")))
    .orderBy(asc(legislators.name));
  const democrats = senate.filter((m) => m.party === "D");
  const republicans = senate.filter((m) => m.party === "R");
  type Call = [string, "yes" | "lean_yes" | "lean_no" | "no", string | null];
  const calls: Call[] = [
    ...democrats.slice(0, 9).map((m, i): Call => [m.id, i < 6 ? "yes" : "lean_yes", i ? null : "Confirmed with chief of staff"]),
    ...republicans.slice(0, 8).map((m, i): Call => [m.id, i < 3 ? "lean_yes" : i < 6 ? "lean_no" : "no", i ? null : "Wants the rural supplement protected"]),
  ];
  if (!calls.length) return;
  const rows = calls.map(([legislatorId, stance, note]) => ({ organizationId: org.id, billId: bill.id, legislatorId, stance, note, updatedAt: new Date() }));
  await db.insert(whipEntries).values(rows);
}
