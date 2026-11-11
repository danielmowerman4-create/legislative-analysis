// npm run center:import-rules -- --slug rep-x --file rules.txt [--activate]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../src/server/db/client";
import { organizations } from "../src/server/db/schema";
import { importSenderRules } from "../src/server/services/center";

const { values } = parseArgs({ options: { slug: { type: "string" }, file: { type: "string" }, activate: { type: "boolean", default: false } } });

async function main() {
  if (!values.slug || !values.file) throw new Error("--slug and --file are required");
  const db = await systemDb();
  const [org] = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.slug, values.slug));
  if (!org) throw new Error(`No office with slug ${values.slug}`);
  const lines = readFileSync(values.file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.split(",")[0].replace(/^"|"$/g, "").trim())
    .filter((l) => l && !/^(address|domain|value|email|sender|rule)/i.test(l));
  const r = await importSenderRules(org.id, lines, { activate: Boolean(values.activate) });
  console.log(`${org.name}: ${r.added} added, ${r.skipped} already there, ${r.refused.length} refused.`);
  for (const x of r.refused) console.log(`  Refused: ${x}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
