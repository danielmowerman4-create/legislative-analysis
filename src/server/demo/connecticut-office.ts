import { and, eq, inArray } from "drizzle-orm";
import { systemDb } from "../db/client";
import { billSponsors, bills, legislators, memberships, organizations, users } from "../db/schema";
import { createSession, loadSession, revokeSession } from "../auth/sessions";
import { lastSuccessfulSync, providerFor, syncJurisdiction } from "../legislation/sync";
import { CT_SESSION } from "../legislation/connecticut";
import { trackBills } from "../services/legislation";
import { centerEnabled, enableConstituentCenter } from "../services/center";
import { addMember, createOffice } from "../services/offices";

const SLUG = "rep-kathy-kennedy";
const MEMBER_ID = "ct-h119";
const ACCOUNTS = [
  { email: "demo.owner@example.org", name: "Office Owner" },
  { email: "demo.cos@example.org", name: "Chief of Staff" },
  { email: "demo.aide@example.org", name: "Legislative Aide" },
];

export async function seedConnecticutOffice() {
  const db = await systemDb();
  const provider = providerFor("CT")!;
  const last = await lastSuccessfulSync(provider.key, "CT");
  const [held] = await db.select({ id: bills.id }).from(bills).where(eq(bills.provider, provider.key)).limit(1);
  if (!held || (provider.snapshotBuiltAt && (!last?.finishedAt || last.finishedAt < provider.snapshotBuiltAt))) {
    const sync = await syncJurisdiction("CT", { provider, sessionIdentifiers: [CT_SESSION.identifier] });
    console.log(`Connecticut 2026 session: ${sync.billsChanged} bills loaded (${sync.status})`);
  }

  const [existing] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, SLUG));
  if (existing) {
    if (!(await centerEnabled(existing.id))) await enableConstituentCenter(existing.id);
    return;
  }

  const { orgId, ownerId } = await createOffice({
    name: "Office of Rep. Kathy Kennedy", slug: SLUG, jurisdictionCode: "CT", chamber: "lower", district: "119", legislatorName: "Rep. Kathy Kennedy",
    owner: { email: ACCOUNTS[0].email, name: ACCOUNTS[0].name },
  });
  const token = await createSession(ownerId, { orgId, mfaVerified: true });
  const owner = (await loadSession(token))!.ctx!;
  await addMember(owner, { email: ACCOUNTS[1].email, name: ACCOUNTS[1].name, roleKey: "chief_of_staff", title: "Chief of Staff" }, { otherOffices: true });
  await addMember(owner, { email: ACCOUNTS[2].email, name: ACCOUNTS[2].name, roleKey: "legislative_aide", title: "Legislative Aide" }, { otherOffices: true });

  for (const a of ACCOUNTS) await db.update(users).set({ name: a.name }).where(eq(users.email, a.email));
  const [fictional] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, "demo-office"));
  const accounts = await db.select({ id: users.id }).from(users).where(inArray(users.email, ACCOUNTS.map((a) => a.email)));
  if (fictional) {
    const shared = and(eq(memberships.organizationId, fictional.id), inArray(memberships.userId, accounts.map((a) => a.id)));
    await db.update(memberships).set({ status: "disabled" }).where(shared);
  }

  const sponsored = await db
    .select({ id: bills.id, type: billSponsors.sponsorType })
    .from(billSponsors)
    .innerJoin(legislators, eq(legislators.id, billSponsors.legislatorId))
    .innerJoin(bills, eq(bills.id, billSponsors.billId))
    .where(and(eq(legislators.provider, provider.key), eq(legislators.providerPersonId, MEMBER_ID)));
  for (const [type, reason] of [["primary", "Introduced by Rep. Kennedy"], ["cosponsor", "Co-sponsored by Rep. Kennedy"]] as const) {
    const ids = sponsored.filter((s) => s.type === type).map((s) => s.id);
    if (ids.length) await trackBills(owner, ids, { position: "support", priority: "normal", reason });
  }
  await revokeSession(token);
  await enableConstituentCenter(orgId);
  console.log(`Office of Rep. Kathy Kennedy ready: ${sponsored.length} bills tracked from her sponsorship record.`);
}
