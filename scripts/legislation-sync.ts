// npm run legislation:check -- --state GA (read-only)
// npm run legislation:sync -- --state GA [--session 2025-2026]
import { parseArgs } from "node:util";
import { count, eq } from "drizzle-orm";
import { LegiScanProvider } from "../src/server/legislation/providers/legiscan";
import { syncJurisdiction } from "../src/server/legislation/sync";
import { STATUS_LABEL } from "../src/server/legislation/normalize";
import { closeDb, systemDb } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { bills } from "../src/server/db/schema";
import type { NormalizedSession } from "../src/server/legislation/types";

const { values } = parseArgs({
  options: {
    state: { type: "string", default: "GA" },
    session: { type: "string" },
    check: { type: "boolean", default: false },
  },
});
const state = values.state!.toUpperCase();

function pickSession(sessions: NormalizedSession[]) {
  if (values.session) {
    const s = sessions.find((x) => x.identifier === values.session);
    if (!s) throw new Error(`No ${state} session "${values.session}". Available: ${sessions.map((x) => x.identifier).join(", ")}`);
    return s;
  }
  return [...sessions].filter((s) => !s.isSpecial).sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""))[0];
}

async function check(provider: LegiScanProvider) {
  const sessions = await provider.listSessions(state);
  const session = pickSession(sessions);
  console.log(`${sessions.length} ${state} sessions on LegiScan. Newest:`);
  for (const s of sessions.slice(0, 6)) console.log(`  ${s.identifier.padEnd(28)} ${s.name}`);
  console.log(`\nSession checked: ${session.name} (LegiScan session_id ${session.providerId})`);

  const changed = await provider.listChangedBills(state, session, null, new Map());
  console.log(`Bills in the session's master list: ${changed.length}`);

  for (const c of changed.slice(0, 3)) {
    const b = await provider.getBill(state, c.providerBillId);
    const primary = b.sponsors.filter((s) => s.type === "primary").map((s) => s.name);
    console.log(`\n${b.identifier}  ${b.title}`);
    console.log(`  Status:      ${STATUS_LABEL[b.status]}${b.statusDate ? ` (${b.statusDate})` : ""}`);
    console.log(`  Last action: ${b.lastActionAt ?? "none"}  ${b.lastActionText ?? ""}`);
    console.log(`  Sponsors:    ${primary.join(", ") || "none listed as primary"} (${b.sponsors.length} total)`);
    console.log(`  Actions ${b.actions.length}, versions ${b.versions.length}, votes ${b.votes.length}, committees ${b.committees.length}, events ${b.events.length}`);
    for (const u of b.sourceUrls) console.log(`  ${u.label}: ${u.url}`);
  }
  console.log(`\nLegiScan queries used: ${provider.queries}. Nothing was written to the database.`);
}

async function sync(provider: LegiScanProvider) {
  await runMigrations();
  const started = Date.now();
  const r = await syncJurisdiction(state, { provider, sessionIdentifiers: values.session ? [values.session] : undefined });
  const db = await systemDb();
  const [{ n }] = await db.select({ n: count() }).from(bills).where(eq(bills.jurisdictionCode, state));
  console.log(`Sync ${r.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`  Bills loaded from the weekly dataset: ${r.bulkLoaded}`);
  console.log(`  Bills written (dataset + changed since): ${r.billsChanged}`);
  console.log(`  Actions added: ${r.actionsAdded}, versions added: ${r.versionsAdded}`);
  console.log(`  ${state} bills stored: ${n}`);
  console.log(`  LegiScan queries used: ${r.queries}`);
  if (r.errors.length) console.log(`  Bills that failed (${r.errors.length}):\n    ${r.errors.slice(0, 10).join("\n    ")}`);
}

async function main() {
  if (!process.env.LEGISCAN_API_KEY) throw new Error("Set LEGISCAN_API_KEY (for example in .env.local).");
  const provider = new LegiScanProvider();
  if (values.check) await check(provider);
  else await sync(provider);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
