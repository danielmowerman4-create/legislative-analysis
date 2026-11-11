// npm run center:enable -- --slug rep-x
// Turning it on also makes two-step sign-in mandatory for that office.
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { closeDb, systemDb } from "../src/server/db/client";
import { organizations } from "../src/server/db/schema";
import { enableConstituentCenter } from "../src/server/services/center";

const { values } = parseArgs({ options: { slug: { type: "string" } } });

async function main() {
  if (!values.slug) throw new Error("--slug is required");
  const db = await systemDb();
  const [org] = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.slug, values.slug));
  if (!org) throw new Error(`No office with slug ${values.slug}`);
  await enableConstituentCenter(org.id);
  console.log(`Constituent Center is on for ${org.name}.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
