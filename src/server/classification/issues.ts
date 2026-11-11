import type { Evidence } from "./schema";

export type TaxonomyNode = { key: string; parentKey: string | null; label: string; keywords: string[]; isActive?: boolean };

type Compiled = { node: TaxonomyNode; patterns: { keyword: string; re: RegExp }[] };

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Short all-caps keywords (ICE, LOST) match case-sensitively; "ice" does not.
function compileKeyword(keyword: string): RegExp {
  const caseSensitive = /^[A-Z0-9()]{2,6}$/.test(keyword.replace(/[\s.]/g, ""));
  const body = escapeRe(keyword).replace(/\\?\s+/g, "\\s+").replace(/'/g, "['’]");
  return new RegExp(`(?<![\\w-])${body}(?![\\w-])`, caseSensitive ? "g" : "gi");
}

// "a+b": both stems in one sentence; anything else is a whole-word phrase.
function compileCooccurrence(keyword: string): RegExp {
  const parts = keyword.split("+").map((p) => escapeRe(p.trim()));
  const ahead = parts.map((p) => `(?=[^.!?\\n]*?\\b${p}\\w*)`).join("");
  return new RegExp(`(?<=^|[.!?\\n]\\s*)${ahead}[^.!?\\n]+`, "gi");
}

export function compileTaxonomy(nodes: TaxonomyNode[]): Compiled[] {
  return nodes
    .filter((n) => n.isActive !== false && n.keywords.length > 0)
    .map((node) => ({ node, patterns: node.keywords.map((k) => ({ keyword: k, re: k.includes("+") ? compileCooccurrence(k) : compileKeyword(k) })) }));
}

export type IssueHit = { key: string; confidence: number; evidence: Evidence[]; keywords: string[]; isLeaf: boolean };

function findAll(re: RegExp, text: string, field: "substantive" | "subject"): Evidence[] {
  const out: Evidence[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], field });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

export function extractIssues(compiled: Compiled[], substantive: string, subject: string): IssueHit[] {
  const childKeys = new Set(compiled.filter((c) => c.node.parentKey).map((c) => c.node.parentKey!));
  const hits: IssueHit[] = [];
  for (const { node, patterns } of compiled) {
    const evidence: Evidence[] = [];
    const matched = new Set<string>();
    let inSubject = false;
    for (const { keyword, re } of patterns) {
      const body = findAll(re, substantive, "substantive");
      const subj = findAll(re, subject, "subject");
      if (body.length || subj.length) matched.add(keyword.toLowerCase());
      if (subj.length) inSubject = true;
      evidence.push(...body, ...subj);
    }
    if (!matched.size) continue;
    const isLeaf = Boolean(node.parentKey) || !childKeys.has(node.key);
    if (!isLeaf && !inSubject && evidence.length < 3) continue;
    const phrase = [...matched].some((k) => /\s|\+/.test(k));
    const confidence = isLeaf
      ? Math.min(0.97, 0.76 + (phrase ? 0.1 : 0) + 0.05 * (matched.size - 1) + 0.02 * Math.min(evidence.length - 1, 3) + (inSubject ? 0.06 : 0))
      : Math.min(0.75, 0.45 + 0.08 * matched.size + (inSubject ? 0.05 : 0));
    evidence.sort((a, b) => (a.field === b.field ? a.start - b.start : a.field === "subject" ? -1 : 1));
    hits.push({ key: node.key, confidence: Number(confidence.toFixed(2)), evidence: evidence.slice(0, 6), keywords: [...matched], isLeaf });
  }
  const matchedParents = new Set(hits.filter((h) => h.isLeaf).map((h) => compiled.find((c) => c.node.key === h.key)?.node.parentKey));
  return hits.filter((h) => h.isLeaf || !matchedParents.has(h.key)).sort((a, b) => b.confidence - a.confidence);
}
