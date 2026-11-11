import { createHash } from "node:crypto";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { systemDb } from "../db/client";
import { bills, rollCalls, sourceDocuments } from "../db/schema";
import { CT_BASE } from "./connecticut";
import { CT_FILES, CT_VOTE_FOLDERS, type CtSnapshot, type CtSource, type StoredDocument } from "./connecticut-build";
import { fetchFromCga, listFtpFolder } from "./connecticut-fetch";

const LAST_REFRESH = "ct:last-refresh";
// A document can appear with no data-file change, so read through daily anyway.
const READ_THROUGH_MS = 24 * 3600_000;
// Getting less than this means a bad read of the state, not a smaller record.
const MIN_SHARE = 0.9;

export function liveCtSource() {
  const files = new Map<string, Promise<string>>();
  const folders = new Map<string, Promise<string[]>>();
  let fingerprint: string | null = null;

  const source = {
    csv(name: (typeof CT_FILES)[number]) {
      if (!files.has(name)) {
        const text = fetchFromCga(`${CT_BASE}/ftp/pub/data/${name}.csv`).then((res) => {
          if (!res.ok) throw new Error(`${name}.csv: ${res.status}`);
          return Buffer.from(res.bytes).toString("latin1");
        });
        files.set(name, text);
      }
      return files.get(name)!;
    },

    listFolder(ftp: string) {
      if (!folders.has(ftp)) folders.set(ftp, listFtpFolder(ftp));
      return folders.get(ftp)!;
    },

    async read(url: string): Promise<StoredDocument | null> {
      const db = await systemDb();
      const [row] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.url, url));
      return row ? { found: row.found, body: row.body, checkedAt: row.checkedAt } : null;
    },

    async write(url: string, found: boolean, body: string | null) {
      const db = await systemDb();
      const set = { found, body, checkedAt: new Date() };
      await db.insert(sourceDocuments).values({ url, ...set }).onConflictDoUpdate({ target: sourceDocuments.url, set });
    },

    async hasNews() {
      const csvs = CT_FILES.map((f) => source.csv(f));
      const parts = await Promise.all([...csvs, ...CT_VOTE_FOLDERS.map((f) => source.listFolder(f.ftp).then((n) => n.join("\n")))]);
      fingerprint = createHash("sha256").update(parts.join("\0")).digest("hex");
      const last = await source.read(LAST_REFRESH);
      return !last || last.body !== fingerprint || Date.now() - last.checkedAt.getTime() > READ_THROUGH_MS;
    },

    async remember() {
      if (fingerprint) await source.write(LAST_REFRESH, true, fingerprint);
    },

    async checkAgainstRecord(s: CtSnapshot) {
      const db = await systemDb();
      const ct = eq(bills.provider, "ctga");
      const [[held], [analyses], [notes], [votes]] = await Promise.all([
        db.select({ n: count() }).from(bills).where(ct),
        db.select({ n: count() }).from(bills).where(and(ct, isNotNull(bills.analysis))),
        db.select({ n: count() }).from(bills).where(and(ct, isNotNull(bills.fiscal))),
        db.select({ n: count() }).from(rollCalls).innerJoin(bills, eq(bills.id, rollCalls.billId)).where(ct),
      ]);
      const read = {
        bills: s.bills.length, analyses: s.bills.filter((b) => b.analysis).length, notes: s.bills.filter((b) => b.fiscal).length,
        votes: s.bills.reduce((n, b) => n + b.votes.length, 0),
      };
      const counts = [
        ["bills", read.bills, held.n], ["analyses", read.analyses, analyses.n], ["fiscal notes", read.notes, notes.n], ["roll calls", read.votes, votes.n],
      ];
      const short = counts.filter(([, got, had]) => (got as number) < (had as number) * MIN_SHARE);
      if (short.length) {
        throw new Error(`Refresh stopped, far less came back than is held: ${short.map(([what, got, had]) => `${what} ${got} of ${had}`).join(", ")}`);
      }
      return read;
    },
  } satisfies CtSource & Record<string, unknown>;
  return source;
}
