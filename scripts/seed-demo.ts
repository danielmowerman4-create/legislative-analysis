// npm run demo:seed (refuses unless APP_ENV=demo)
// On pglite the shared password is "password"; elsewhere each account gets a random one.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getEnv } from "../src/server/env";
import { runMigrations } from "../src/server/db/migrate";
import { closeDb, systemDb } from "../src/server/db/client";
import { bills, organizations, users } from "../src/server/db/schema";
import { hashPassword } from "../src/server/auth/password";
import { createOffice, addMember } from "../src/server/services/offices";
import { loadSession, createSession } from "../src/server/auth/sessions";
import { registerDemoProviders } from "../src/server/demo/register";
import { DEMO_SESSIONS } from "../src/server/demo/legislative-fixture";
import { syncJurisdiction } from "../src/server/legislation/sync";
import { drainJobs } from "../src/server/jobs/runner";
import { addBillNote, linkBills, trackBills, type TrackInput } from "../src/server/services/legislation";
import { seedDemoTools } from "../src/server/demo/tools-seed";
import { seedConnecticutOffice } from "../src/server/demo/connecticut-office";
import { demoPassword, seedConstituentCenterDemo } from "../src/server/demo/center-seed";

// Real accounts keep the 12-character minimum; the short demo password is set after.
const INITIAL_PASSWORD = randomUUID();
const DEMO_EMAILS = ["demo.owner@example.org", "demo.cos@example.org", "demo.aide@example.org"];

// [provider bill id, position, priority, why the office tracks it]
const TRACKED: [string, TrackInput["position"], TrackInput["priority"], string][] = [
  ["zz-hb142", "support", "high", "School funding for District 42"],
  ["zz-sb151", "support", "high", "Senate companion to HB 142"],
  ["zz-hb412", "support", "high", "Our bill"],
  ["zz-hb310", "support", "high", "Our bill"],
  ["zz-hb230", "support", "normal", "Co-sponsor"],
  ["zz-sb205", "support", "normal", "Overlaps HB 412"],
  ["zz-sb40", "oppose", "normal", "Speed cameras near Riverside schools"],
  ["zz-hb388", "support", "normal", "Repeals SB 40's cameras"],
  ["zz-hb501", "support", "normal", "Co-sponsor"],
  ["zz-hb128", "support", "normal", ""],
  ["zz-sb112", "support", "low", ""],
  ["zz-hb615", "watching", "low", ""],
  ["zz-hb95", "oppose", "low", ""],
];

// The embedded database has no cross-process lock: two writers can damage it.
function refuseIfDevServerShares(databaseUrl: string) {
  const target = databaseUrl.replace(/^pglite:\/\//, "");
  if (!databaseUrl.startsWith("pglite://") || path.isAbsolute(target) || !existsSync(".next/dev/lock")) return;
  const { pid } = JSON.parse(readFileSync(".next/dev/lock", "utf8")) as { pid: number };
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  throw new Error(`Refusing to seed: a dev server (process ${pid}) is using ${target}. Stop it first.`);
}

async function main() {
  const env = getEnv();
  if (env.APP_ENV !== "demo") throw new Error("Refusing to seed: APP_ENV must be 'demo'.");
  refuseIfDevServerShares(env.DATABASE_URL);
  await runMigrations();
  const db = await systemDb();
  const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, "demo-office"));
  if (existing.length) {
    await seedDemoTools();
    await seedConnecticutOffice();
    await seedConstituentCenterDemo();
    console.log("Demo office already exists. Delete the demo database directory to reseed.");
    return;
  }
  registerDemoProviders();
  const held = new Set((await db.select({ email: users.email }).from(users).where(inArray(users.email, DEMO_EMAILS))).map((u) => u.email));

  const password = INITIAL_PASSWORD;
  const { orgId, ownerId } = await createOffice({
    name: "Office of Rep. Jordan Ellis (Demo)", slug: "demo-office", jurisdictionCode: "ZZ", chamber: "lower", district: "42",
    legislatorName: "Rep. Jordan Ellis", isDemo: true, owner: { email: "demo.owner@example.org", name: "Morgan Hale", password },
  });
  const owner = (await loadSession(await createSession(ownerId, { orgId, mfaVerified: true })))!.ctx!;
  await addMember(owner, { email: "demo.cos@example.org", name: "Taylor Brooks", roleKey: "chief_of_staff", title: "Chief of Staff", password });
  await addMember(owner, { email: "demo.aide@example.org", name: "Sam Patel", roleKey: "legislative_aide", title: "Legislative Aide", password });
  for (const email of DEMO_EMAILS.filter((e) => !held.has(e))) {
    const shared = demoPassword();
    await db.update(users).set({ passwordHash: await hashPassword(shared), mustChangePassword: false }).where(eq(users.email, email));
    console.log(`Demo sign-in: ${email} / ${shared}`);
  }

  // The earlier session too, so bills can link to their previous versions.
  const sync = await syncJurisdiction("ZZ", { sessionIdentifiers: DEMO_SESSIONS().map((s) => s.identifier) });
  console.log(`Legislative sync: ${sync.billsChanged} bills`);
  const billIds = Object.fromEntries((await db.select({ id: bills.id, pid: bills.providerBillId }).from(bills)).map((b) => [b.pid, b.id]));
  for (const [pid, position, priority, reason] of TRACKED) await trackBills(owner, [billIds[pid]], { position, priority, reason: reason || null });
  await linkBills(owner, billIds["zz-hb230"], billIds["zz-hb142"], "Both draw on the same education budget line");
  await addBillNote(owner, billIds["zz-hb142"], "Senate hearing Thursday. Rep. Ellis wants the rural supplement kept at $250 or higher.");
  await addBillNote(owner, billIds["zz-sb40"], "Riverside PTA opposes cameras on Elm Street. Coordinate with Rep. Pruitt on HB 388.");

  await drainJobs();
  await seedDemoTools();
  await seedConnecticutOffice();
  await seedConstituentCenterDemo();
  console.log("Demo environment ready. Sign in as demo.owner@example.org with the password printed above.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
