// npx tsx scripts/ct-snapshot.ts --cache <dir> [--limit N]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { CT_BASE } from "../src/server/legislation/connecticut";
import { buildConnecticutSession, type CtSource } from "../src/server/legislation/connecticut-build";
import { fetchFromCga, listFtpFolder } from "../src/server/legislation/connecticut-fetch";

const OUT = "data/connecticut/2026.json.gz";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const cache = arg("cache");
if (!cache) throw new Error("Pass --cache <dir>.");
const limit = Number(arg("limit") ?? 0);
for (const dir of ["text", "votes", "analyses", "fiscal"]) mkdirSync(join(cache, dir), { recursive: true });

const known = join(cache, "documents.json");
const docs: Record<string, boolean> = existsSync(known) ? JSON.parse(readFileSync(known, "utf8")) : {};
let writes = 0;
const saveDocs = () => writeFileSync(known, JSON.stringify(docs));

function fileFor(url: string) {
  const name = url.split("/").pop()!;
  if (/\/(VOTE|TS)\//.test(url)) return join(cache!, "votes", `${name}.txt`);
  if (/\/BA\//.test(url)) return join(cache!, "analyses", `${name}.txt`);
  if (/\/FN\//.test(url)) return join(cache!, "fiscal", `${name}.xml`);
  return join(cache!, "text", `${name.replace(/\.PDF$/i, "")}.txt`);
}

const source: CtSource = {
  async csv(name) {
    const file = join(cache!, `${name}.csv`);
    if (!existsSync(file)) {
      const res = await fetchFromCga(`${CT_BASE}/ftp/pub/data/${name}.csv`);
      if (!res.ok) throw new Error(`${name}.csv: ${res.status}`);
      writeFileSync(file, res.bytes);
    }
    return readFileSync(file, "latin1");
  },
  async listFolder(ftp) {
    const file = join(cache!, `list-${ftp.replace(/\//g, "-")}.txt`);
    if (!existsSync(file)) writeFileSync(file, (await listFtpFolder(ftp)).join("\n"));
    return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /\.pdf$/i.test(l));
  },
  async read(url) {
    const file = fileFor(url);
    if (existsSync(file)) return { found: true, body: readFileSync(file, "utf8"), checkedAt: new Date() };
    return url in docs ? { found: docs[url], body: null, checkedAt: new Date() } : null;
  },
  async write(url, found, body) {
    if (body !== null) writeFileSync(fileFor(url), body);
    docs[url] = found;
    if (++writes % 25 === 0) saveDocs();
  },
};

async function main() {
  const { snapshot, stats } = await buildConnecticutSession(source, { limit, onProgress: console.log });
  saveDocs();
  const body = gzipSync(JSON.stringify(snapshot), { level: 9 });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  const meta = { builtAt: snapshot.builtAt, latestAction: snapshot.sourceFilesDated, bills: snapshot.bills.length };
  writeFileSync(OUT.replace(".json.gz", ".meta.json"), `${JSON.stringify(meta)}\n`);
  const texts = Object.keys(snapshot.versionTexts).length;
  const mb = (body.length / 1e6).toFixed(2);
  console.log(`Wrote ${OUT}: ${snapshot.bills.length} bills, ${snapshot.people.length} members, ${texts} full texts, ${mb} MB, ${stats.requests} requests`);
  console.log("Analyses:", JSON.stringify(stats.analysisStats));
  console.log("Fiscal notes:", JSON.stringify(stats.fiscalStats));
  console.log("Votes:", JSON.stringify(stats.voteStats), "member votes:", Object.values(snapshot.rollCallVotes).reduce((n, v) => n + v.length, 0));
  console.log("Names not matched to a current member:", JSON.stringify(stats.unmatched));
  console.log("Vote issues:", stats.voteProblems.length, JSON.stringify(stats.voteProblems.slice(0, 40)));
  for (const line of stats.problems) console.warn(line);
  if (stats.unknownPhrases.length) console.log("Untranslated phrases:", stats.unknownPhrases);
  if (stats.unknownSponsors.length) console.log("Introducer codes with no name:", stats.unknownSponsors);
}

main().catch((e) => {
  saveDocs();
  console.error(e);
  process.exitCode = 1;
});
