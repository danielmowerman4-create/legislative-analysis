// npm run office:create -- --name N --slug S --state GA --owner-email E --owner-name N
// The owner's password comes from OWNER_PASSWORD, never the command line.
import { parseArgs } from "node:util";
import { createOffice } from "../src/server/services/offices";
import { closeDb } from "../src/server/db/client";

const { values } = parseArgs({
  options: {
    name: { type: "string" }, slug: { type: "string" }, state: { type: "string" }, chamber: { type: "string", default: "lower" },
    district: { type: "string" }, legislator: { type: "string" }, "owner-email": { type: "string" }, "owner-name": { type: "string" },
    domains: { type: "string", default: "" }, "temporary-password": { type: "boolean", default: false },
  },
});

async function main() {
  const required = ["name", "slug", "state", "owner-email", "owner-name"] as const;
  for (const r of required) if (!values[r]) throw new Error(`--${r} is required`);
  const password = process.env.OWNER_PASSWORD;
  if (!password) throw new Error("Set OWNER_PASSWORD in the environment for the owner's initial password.");
  const r = await createOffice({
    name: values.name!, slug: values.slug!, jurisdictionCode: values.state!.toUpperCase(), chamber: values.chamber as "upper" | "lower",
    district: values.district, legislatorName: values.legislator, internalDomains: values.domains!.split(",").filter(Boolean),
    owner: { email: values["owner-email"]!, name: values["owner-name"]!, password, temporary: values["temporary-password"] },
  });
  console.log(`Created office ${r.orgId} with owner ${r.ownerId}. Every feature is on; connect a mailbox in Settings.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
