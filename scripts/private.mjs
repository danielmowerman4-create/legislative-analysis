#!/usr/bin/env node
// npm run private [-- --update]: one private copy of the app, kept in ~/ConstituentCenter.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = path.resolve(process.env.CC_HOME ?? path.join(homedir(), "ConstituentCenter"));
const HOST = "127.0.0.1";
const SETTINGS = path.join(HOME, "settings.env");
const APP = path.join(HOME, "app");
const DB = path.join(HOME, "db");
const BACKUPS = path.join(HOME, "backups");
const PID = path.join(HOME, "server.pid");
const OFFICE_READY = path.join(HOME, "office-ready");
const KEEP_BACKUPS = 14;

const say = (s) => console.log(s);
function stop(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function refuseSyncedFolders() {
  const home = homedir();
  const synced = [path.join(home, "Documents"), path.join(home, "Desktop"), path.join(home, "Library", "Mobile Documents")];
  if (synced.some((d) => HOME === d || HOME.startsWith(`${d}${path.sep}`)) || /icloud|dropbox|onedrive|google drive/i.test(HOME)) {
    stop(`${HOME} is a folder that syncs to the cloud. Constituent mail cannot live there.`);
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function projectKeys() {
  const file = path.join(PROJECT, ".env.local");
  if (!existsSync(file)) return {};
  const all = parseEnv(readFileSync(file, "utf8"));
  const clean = (v) => (v ?? "").split(/\s+#/)[0].trim();
  const keys = [
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT",
    "LEGISCAN_API_KEY", "ANTHROPIC_API_KEY", "GEOCODIO_API_KEY",
  ];
  return Object.fromEntries(keys.map((k) => [k, clean(all[k])]).filter(([, v]) => v));
}

// Google only accepts the registered return address, port 3000 for this project's key.
const PORT = (() => {
  if (process.env.CC_PORT) return Number(process.env.CC_PORT);
  if (existsSync(SETTINGS)) return Number(parseEnv(readFileSync(SETTINGS, "utf8")).APP_URL?.split(":").pop()) || 3300;
  return projectKeys().GOOGLE_CLIENT_ID ? 3000 : 3300;
})();

function fillBlanksFromProject() {
  const keys = projectKeys();
  const text = readFileSync(SETTINGS, "utf8");
  const filled = text.replace(/^([A-Z_]+)=\s*$/gm, (line, k) => (keys[k] ? `${k}=${keys[k]}` : line));
  if (filled !== text) writeFileSync(SETTINGS, filled, { mode: 0o600 });
}

function createSettings() {
  const lines = [
    "# Private settings for this computer. Readable only by you. Never copy this file anywhere.",
    "APP_ENV=development",
    `APP_URL=http://localhost:${PORT}`,
    `DATABASE_URL=pglite://${DB}`,
    `SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
    `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "TOKEN_ENCRYPTION_KEY_ID=k1",
    "WORKER_MODE=inline",
    "CT_SOURCE=live",
    "NEXT_PUBLIC_DISPLAY_TIMEZONE=America/New_York",
    "NEXT_TELEMETRY_DISABLED=1",
    "",
    "# Optional sign-in buttons for mailboxes. An app password works without these.",
    "MICROSOFT_CLIENT_ID=",
    "MICROSOFT_CLIENT_SECRET=",
    "MICROSOFT_TENANT=common",
    "GOOGLE_CLIENT_ID=",
    "GOOGLE_CLIENT_SECRET=",
    "",
    "# Bills: needed for every state except Connecticut.",
    "LEGISCAN_API_KEY=",
    "",
    "# Optional. Left blank, nothing is sent to these services.",
    "ANTHROPIC_API_KEY=",
    "GEOCODIO_API_KEY=",
    "",
  ];
  writeFileSync(SETTINGS, lines.join("\n"), { mode: 0o600 });
  say(`Created your private settings in ${SETTINGS}`);
}

function run(command, args, env, cwd = APP) {
  const r = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) stop(`This step failed: ${command} ${args.join(" ")}`);
}

const tool = (name) => path.join(APP, "node_modules", ".bin", name);

function copyCode() {
  say("Copying the app out of the synced project folder...");
  mkdirSync(APP, { recursive: true });
  const exclude = [".git", ".next", ".data", "node_modules", ".env*", "coverage", "backups", ".scratch", "*.tsbuildinfo", "* [0-9].*"];
  run("rsync", ["-a", "--delete", ...exclude.flatMap((e) => ["--exclude", e]), `${PROJECT}/`, `${APP}/`], process.env, PROJECT);
  const lock = (root) => (existsSync(path.join(root, "package-lock.json")) ? readFileSync(path.join(root, "package-lock.json"), "utf8") : "");
  const stamp = path.join(HOME, "installed-lock");
  if (!existsSync(path.join(APP, "node_modules")) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== lock(PROJECT)) {
    say("Copying its libraries...");
    rmSync(path.join(APP, "node_modules"), { recursive: true, force: true });
    // Cloned on APFS, so this takes seconds and almost no disk.
    run("cp", ["-cR", path.join(PROJECT, "node_modules"), path.join(APP, "node_modules")], process.env, PROJECT);
    writeFileSync(stamp, lock(PROJECT));
  }
}

function build(env) {
  say("Building it...");
  rmSync(path.join(APP, ".next"), { recursive: true, force: true });
  run(tool("next"), ["build"], { ...env, NODE_ENV: "production" });
}

const portInUse = () =>
  new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port: PORT });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

function refuseIfRunning() {
  if (!existsSync(PID)) return;
  const pid = Number(readFileSync(PID, "utf8"));
  try {
    process.kill(pid, 0);
  } catch {
    rmSync(PID);
    return;
  }
  stop(`It is already running (process ${pid}). The database takes one program at a time, so this will not start a second.`);
}

async function askAboutOffice() {
  if (process.env.CC_OFFICE_NAME) {
    return {
      name: process.env.CC_OFFICE_NAME, state: process.env.CC_STATE, district: process.env.CC_DISTRICT, legislator: process.env.CC_LEGISLATOR,
      ownerName: process.env.CC_OWNER_NAME, email: process.env.CC_OWNER_EMAIL, password: process.env.CC_OWNER_PASSWORD,
    };
  }
  if (!process.stdin.isTTY) stop("Run this in a terminal so it can ask about the office.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  say("\nA few questions about the office. These stay on this computer.\n");
  const need = async (q) => {
    for (;;) {
      const a = (await rl.question(`${q}: `)).trim();
      if (a) return a;
    }
  };
  const answers = {
    name: await need("Office name (Office of Rep. Jane Smith)"), state: (await need("State, two letters (GA)")).toUpperCase(),
    district: await need("District number"), legislator: await need("Legislator's name (Rep. Jane Smith)"),
    ownerName: await need("Your name"), email: await need("Your email, used to sign in"),
  };
  rl.close();
  answers.password = await askPassword();
  return answers;
}

function askPassword() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stdout.write("Choose a password, 12 characters or more (it will not show): ");
    let typed = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") process.exit(1);
        if (ch === "\r" || ch === "\n") {
          if (typed.length < 12) {
            typed = "";
            process.stdout.write("\nThat is under 12 characters. Try again: ");
            continue;
          }
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(typed);
          return;
        }
        if (ch === "\u007f") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function setUpOffice(env, a) {
  const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const chamber = /\bsen/i.test(a.legislator) ? "upper" : "lower";
  run(tool("tsx"), ["scripts/migrate.ts"], env);
  const domains = a.email.split("@")[1]?.endsWith(".gov") ? a.email.split("@")[1] : "";
  const args = [
    "scripts/create-office.ts", "--name", a.name, "--slug", slug, "--state", a.state, "--chamber", chamber, "--district", a.district,
    "--legislator", a.legislator, "--owner-email", a.email, "--owner-name", a.ownerName, "--domains", domains,
  ];
  run(tool("tsx"), args, { ...env, OWNER_PASSWORD: a.password });
  writeFileSync(OFFICE_READY, `${slug}\n${a.state}\n`, { mode: 0o600 });
}

function backUp() {
  if (!existsSync(DB) || !readdirSync(DB).length) return;
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const target = path.join(BACKUPS, stamp);
  if (!existsSync(target)) run("cp", ["-cR", DB, target], process.env, HOME);
  const all = readdirSync(BACKUPS).filter((d) => statSync(path.join(BACKUPS, d)).isDirectory()).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
}

function reportMissing(settings) {
  const state = readFileSync(OFFICE_READY, "utf8").split("\n")[1]?.toUpperCase();
  if (state && state !== "CT" && !settings.LEGISCAN_API_KEY) say(`\nBills for ${state} need a LegiScan key in ${SETTINGS}. Everything else works without one.`);
}

async function main() {
  refuseSyncedFolders();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  chmodSync(HOME, 0o700);
  refuseIfRunning();
  if (await portInUse()) stop(`Something else is already using port ${PORT}. Set CC_PORT to another number.`);
  if (!existsSync(SETTINGS)) createSettings();
  chmodSync(SETTINGS, 0o600);
  fillBlanksFromProject();
  const settings = parseEnv(readFileSync(SETTINGS, "utf8"));
  const env = { ...process.env, ...settings };

  const update = process.argv.includes("--update");
  const firstRun = !existsSync(path.join(APP, ".next", "BUILD_ID"));
  if (firstRun || update) {
    if (update) backUp();
    copyCode();
    build(env);
  }
  if (!existsSync(OFFICE_READY)) setUpOffice(env, await askAboutOffice());
  else run(tool("tsx"), ["scripts/migrate.ts"], env);
  backUp();

  const server = spawn(tool("next"), ["start", "-H", HOST, "-p", String(PORT)], { cwd: APP, env: { ...env, NODE_ENV: "production" }, stdio: "inherit" });
  writeFileSync(PID, String(server.pid), { mode: 0o600 });
  say(`\nConstituent Center is running at http://localhost:${PORT}\nOnly this computer can reach it. Press Control-C to stop it.`);
  reportMissing(settings);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
  server.on("exit", (code) => {
    rmSync(PID, { force: true });
    process.exit(code ?? 0);
  });
}

main().catch((e) => stop(e.message));
