import type { BillRelationKind } from "../db/schema";

// LegiScan "sast" type ids.
export const LEGISCAN_SAST_KIND: Record<number, BillRelationKind> = {
  1: "same_as", 2: "similar_to", 3: "replaced_by", 4: "replaces", 5: "cross_filed", 6: "enabling", 7: "enabled_by", 8: "related", 9: "carry_over",
};

const RELATION_LABEL: Record<BillRelationKind, string> = {
  same_as: "Same as", similar_to: "Similar to", replaces: "Replaces", replaced_by: "Replaced by", cross_filed: "Cross-filed with",
  enabling: "Enabling act for", enabled_by: "Enabled by", related: "Related to", carry_over: "Carried over from",
};

const SECTION = /\b(\d{1,2}[A-Z]?)-(\d{1,3}[A-Z]?)-(\d{1,4}(?:\.\d{1,3})?)\b/g;
const CHAPTER = /\bChapters?\s+(\d{1,3}[A-Z]?)(?:\s*(?:,|and)\s*\d{1,3}[A-Z]?)*\s+of\s+Title\s+(\d{1,2}[A-Z]?)\b/gi;
// Only sections a Connecticut bill repeals or amends count, not ones it mentions.
const CT_STATUTES = String.raw`of\s+the\s+(?:\d{4}\s+supplement\s+to\s+the\s+)?general\s+statutes(?:,?\s+as\s+amended\s+by[^.]{0,120}?,)?\s+(?:is|are|be)\s+(?:hereby\s+)?(?:repealed|amended)`;
const CT_SECTION = new RegExp(String.raw`\bsections?\s+((?:\d+[a-z]{0,3}-\d+[a-z]{0,4}(?:\s*,\s*(?:and\s+|to\s+)?|\s+(?:and|to)\s+)?)+)(?:,?\s*inclusive,?\s*)?\s*${CT_STATUTES}`, "gi");
const CT_CITATION = /\d+[a-z]{0,3}-\d+[a-z]{0,4}/gi;
const CT_CHAPTER = new RegExp(String.raw`\bchapter\s+(\d+[a-z]{0,2})\s+${CT_STATUTES}`, "gi");

// Each section also yields its chapter, so bills in one chapter still connect.
export function extractCodeSections(...texts: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const text = raw.replace(/‑|–/g, "-");
    for (const m of text.matchAll(SECTION)) {
      out.add(`${m[1]}-${m[2]}-${m[3]}`);
      out.add(`${m[1]}-${m[2]}`);
    }
    for (const m of text.matchAll(CHAPTER)) out.add(`${m[2]}-${m[1]}`);
    for (const m of text.matchAll(CT_SECTION)) for (const c of m[1].matchAll(CT_CITATION)) out.add(`cgs:${c[0].toLowerCase()}`);
    for (const m of text.matchAll(CT_CHAPTER)) out.add(`cgs:ch${m[1].toLowerCase()}`);
  }
  return [...out].sort(compareCitations);
}

export const isSection = (c: string) => (c.startsWith("cgs:") ? !c.startsWith("cgs:ch") : c.split("-").length === 3);

const citationParts = (c: string) => c.replace(/^cgs:(ch)?/, "").split(/[-.]/).map((x) => parseFloat(x) || 0);

function compareCitations(a: string, b: string) {
  const pa = citationParts(a);
  const pb = citationParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? -1) !== (pb[i] ?? -1)) return (pa[i] ?? -1) - (pb[i] ?? -1);
  return 0;
}

export function citationLabel(c: string) {
  if (c.startsWith("cgs:ch")) return `C.G.S. Chapter ${c.slice(6)}`;
  if (c.startsWith("cgs:")) return `C.G.S. § ${c.slice(4)}`;
  const [title, chapter] = c.split("-");
  return isSection(c) ? `§ ${c}` : `Title ${title}, Chapter ${chapter}`;
}

const STOP = new Set("bill entitled amend amended amending official code georgia connecticut concerning establishing requiring regarding certain various annotated relating provide provides provided provision provisions purposes other repeal conflicting laws related matters effective date section sections chapter chapters title article articles state such that this with from into upon their which shall revise revised change changes changing include including within under among".split(" "));

export function titleTerms(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
}

export function titleSimilarity(a: string, b: string) {
  const x = titleTerms(a);
  const y = titleTerms(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export type RelatedReason =
  | { kind: "source"; relation: BillRelationKind }
  | { kind: "office"; note: string | null }
  | { kind: "companion" }
  | { kind: "earlier_session"; session: string }
  | { kind: "later_session"; session: string }
  | { kind: "code"; citations: string[] }
  | { kind: "sponsor"; name: string }
  | { kind: "subject"; subjects: string[] };

export function reasonWeight(r: RelatedReason, similarity: number) {
  switch (r.kind) {
    case "office":
      return 100;
    case "source":
      return 80;
    case "companion":
      return 60 + similarity * 20;
    case "earlier_session":
    case "later_session":
      return 40 + similarity * 20;
    case "code":
      return r.citations.some(isSection) ? 35 : 12;
    case "sponsor":
      return 8;
    case "subject":
      return 4 * r.subjects.length;
  }
}

export function reasonText(r: RelatedReason, otherChamber?: string) {
  switch (r.kind) {
    case "source":
      return `${RELATION_LABEL[r.relation]} (per the legislature's record)`;
    case "office":
      return r.note ? `Linked by your office: ${r.note}` : "Linked by your office";
    case "companion":
      return `Companion bill${otherChamber ? ` in the ${otherChamber}` : ""}`;
    case "earlier_session":
      return `Earlier version, ${r.session}`;
    case "later_session":
      return `Later version, ${r.session}`;
    case "code": {
      const sections = r.citations.filter(isSection);
      const pool = sections.length ? sections : r.citations;
      const shown = pool.slice(0, 3).map(citationLabel);
      const more = pool.length - shown.length;
      return `Both change ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
    }
    case "sponsor":
      return `Same lead sponsor, ${r.name}`;
    case "subject":
      return `Same subject: ${r.subjects.slice(0, 2).join(", ")}`;
  }
}
