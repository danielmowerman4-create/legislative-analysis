// Usage: node scripts/with-env.mjs <envfile> <command> [...args]
// Next.js only auto-loads .env, .env.local and .env.<NODE_ENV>.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const [file, cmd, ...args] = process.argv.slice(2);
const env = { ...process.env };
for (const line of readFileSync(file, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2];
}
const bin = path.resolve("node_modules/.bin", cmd);
const child = spawn(bin, args, { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
