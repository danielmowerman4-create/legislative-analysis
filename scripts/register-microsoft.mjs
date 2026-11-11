#!/usr/bin/env node
// npm run microsoft:register [-- --dry-run] [--yes] [--expect-domain example.gov]
// Needs `az login --allow-no-subscriptions` and RAILWAY_APP_URL. The secret is never printed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const ASSUME_YES = process.argv.includes("--yes");
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const EXPECT_DOMAIN = process.argv.includes("--expect-domain") ? flag("--expect-domain") : null;
const NAME = "Constituent Center";
const GRAPH = "00000003-0000-0000-c000-000000000000";
const DELEGATED = ["openid", "email", "offline_access", "User.Read", "Mail.Read"];

const say = (s) => console.log(s);
function stop(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const RAILWAY_URL = (process.env.RAILWAY_APP_URL || process.env.APP_URL || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(RAILWAY_URL)) {
  stop("Set RAILWAY_APP_URL (or APP_URL) to the live server's https address, such as https://your-app.up.railway.app");
}
const CALLBACK = "/api/integrations/microsoft/callback";
const REDIRECTS = [`${RAILWAY_URL}${CALLBACK}`, `http://localhost:3000${CALLBACK}`, `http://localhost:3300${CALLBACK}`];

// Output is returned, not printed: the app secret passes through here.
function run(cmd, args, { quiet = false } = {}) {
  if (DRY) {
    say(`  would run: ${cmd} ${args.map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a)).join(" ")}`);
    return "";
  }
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"] }).trim();
  } catch (e) {
    stop(`This step failed: ${cmd} ${args[0]} ${args[1] ?? ""}\n${(e.stderr ?? "").toString().split("\n").slice(0, 4).join("\n")}`);
  }
}

const json = (cmd, args) => {
  const out = run(cmd, args);
  return DRY ? null : JSON.parse(out || "null");
};

function setLines(file, values) {
  if (DRY) return say(`  would write ${Object.keys(values).join(", ")} into ${file}`);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  let next = text;
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    next = new RegExp(`^${k}=.*$`, "m").test(next) ? next.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${next.replace(/\n?$/, "\n")}${line}\n`;
  }
  writeFileSync(file, next, { mode: 0o600 });
}

async function main() {
  say("Checking the Microsoft sign-in on this computer...");
  const who = "{tenant:tenantId, name:tenantDisplayName, domain:tenantDefaultDomain, user:user.name}";
  const account = json("az", ["account", "show", "--query", who, "-o", "json"]);
  if (!DRY && !account) stop("Not signed in. Run: az login --allow-no-subscriptions");
  if (!DRY) json("az", ["ad", "signed-in-user", "show", "--query", "id", "-o", "json"]);
  say(DRY ? "  (dry run: no directory read)" : `\nThe app will be created in "${account.name}" (${account.domain}), signed in as ${account.user}.`);
  if (!DRY && EXPECT_DOMAIN) {
    const res = await fetch(`https://login.microsoftonline.com/${EXPECT_DOMAIN}/v2.0/.well-known/openid-configuration`);
    const expected = (await res.json()).issuer?.match(/\/([0-9a-f-]{36})\//)?.[1];
    if (!expected || expected !== account.tenant) stop(`Signed in to "${account.name}", which is not ${EXPECT_DOMAIN}'s directory. Nothing was created.`);
  }
  if (!DRY && !ASSUME_YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Is that the right Microsoft account to own it? Type yes to continue: ")).trim().toLowerCase();
    rl.close();
    if (answer !== "yes") stop("Nothing was created. Sign in as the right account with: az login --allow-no-subscriptions");
  }

  const existing = json("az", ["ad", "app", "list", "--display-name", NAME, "--query", "[].appId", "-o", "json"]);
  if (existing?.length) stop(`An app called "${NAME}" already exists in this directory (${existing[0]}). Nothing was changed.`);

  say("Reading Microsoft's permission IDs...");
  const ids = "{scopes: oauth2PermissionScopes[].{v:value,id:id}, roles: appRoles[].{v:value,id:id}}";
  const graph = json("az", ["ad", "sp", "show", "--id", GRAPH, "--query", ids, "-o", "json"]);
  const scopeId = (v) => graph?.scopes.find((s) => s.v === v)?.id ?? `<${v}>`;
  const roleId = (v) => graph?.roles.find((s) => s.v === v)?.id ?? `<${v}>`;
  const resourceAccess = [...DELEGATED.map((v) => ({ id: scopeId(v), type: "Scope" })), { id: roleId("Mail.Read"), type: "Role" }];
  const access = [{ resourceAppId: GRAPH, resourceAccess }];
  const manifest = path.join(homedir(), ".constituent-center-graph-access.json");
  if (!DRY) writeFileSync(manifest, JSON.stringify(access), { mode: 0o600 });

  say("Registering the app...");
  const create = ["ad", "app", "create", "--display-name", NAME, "--sign-in-audience", "AzureADMultipleOrgs", "--web-redirect-uris", ...REDIRECTS];
  const app = json("az", [...create, "--required-resource-accesses", `@${manifest}`, "--query", "{appId:appId, id:id}", "-o", "json"]);
  const appId = app?.appId ?? "<app id>";
  // Personal Outlook.com and Hotmail accounts need version 2 tokens.
  let tenant = "organizations";
  if (DRY) say("  would allow personal Outlook.com accounts too (version 2 tokens), if Microsoft accepts it");
  else {
    try {
      execFileSync("az", ["ad", "app", "update", "--id", appId, "--set", "api.requestedAccessTokenVersion=2"], { stdio: "pipe" });
      execFileSync("az", ["ad", "app", "update", "--id", appId, "--sign-in-audience", "AzureADandPersonalMicrosoftAccount"], { stdio: "pipe" });
      tenant = "common";
    } catch {
      say("  Personal Outlook.com accounts could not be added; work and government mailboxes are unaffected.");
    }
  }
  run("az", ["ad", "sp", "create", "--id", appId], { quiet: true });

  say("Making its secret and storing it where it is needed (it is not shown)...");
  const reset = ["ad", "app", "credential", "reset", "--id", appId, "--display-name", "constituent-center", "--years", "2", "--query", "password", "-o", "tsv"];
  const secret = run("az", reset, { quiet: true });
  const values = { MICROSOFT_CLIENT_ID: appId, MICROSOFT_CLIENT_SECRET: secret || "<secret>", MICROSOFT_TENANT: tenant };

  setLines(path.join(PROJECT, ".env.local"), values);
  const privateSettings = path.join(homedir(), "ConstituentCenter", "settings.env");
  if (existsSync(privateSettings)) setLines(privateSettings, values);
  run("railway", ["variables", "--service", "web", ...Object.entries(values).flatMap(([k, v]) => ["--set", `${k}=${v}`])], { quiet: true });

  say(`\nDone. App ID ${appId}. Railway is redeploying with Microsoft sign-in; it takes about two minutes.`);
  say("Each organization's IT approves the app once before its staff can connect. Personal accounts approve it themselves.");
}

main().catch((e) => stop(e.message));
