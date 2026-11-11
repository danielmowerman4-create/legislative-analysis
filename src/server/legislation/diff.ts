import { diffWords } from "diff";

type Section = { label: string; heading: string; text: string };
type BeforeAfter = { before: string[]; after: string[] };
export type SectionChange = {
  label: string; heading: string; status: "added" | "removed" | "modified" | "unchanged"; tags: ("definitions" | "appropriations" | "dates")[];
  parts: { value: string; added?: boolean; removed?: boolean }[]; amounts: BeforeAfter; dates: BeforeAfter; definedTerms: BeforeAfter;
};
export type VersionComparison = { sections: SectionChange[]; counts: Record<SectionChange["status"], number>; findings: string[] };

const HEADING = /^[ \t]*(SECTION|Section|SEC\.|Sec\.|§)\s*([0-9]+[A-Za-z]?(?:[.-][0-9]+)*)\.?[ \t]*(.*)$/gm;
const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion))?/gi;
const DATE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g;
const DEFINED = /["“]([A-Z][^"”]{1,60})["”]\s+means\b/g;

function splitSections(text: string): Section[] {
  const t = text.replace(/\r\n?/g, "\n");
  const heads = [...t.matchAll(HEADING)];
  if (!heads.length) return [{ label: "Full text", heading: "", text: t.trim() }];
  const out: Section[] = [];
  const preamble = t.slice(0, heads[0].index).trim();
  if (preamble) out.push({ label: "Preamble", heading: "", text: preamble });
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index! : t.length;
    const base = `Section ${h[2]}`;
    let label = base;
    let n = 2;
    while (out.some((s) => s.label === label)) label = `${base} (${n++})`;
    out.push({ label, heading: h[3].trim().replace(/[.:;,]+$/, "").slice(0, 120), text: t.slice(h.index!, end).trim() });
  });
  return out;
}

const normalizeWs = (s: string) => s.replace(/\s+/g, " ").trim();
const uniq = (xs: string[]) => [...new Set(xs.map(normalizeWs))];
const all = (re: RegExp, s: string) => uniq([...s.matchAll(re)].map((m) => m[1] ?? m[0]));
const listed = (xs: string[]) => xs.join(", ") || "none";
const either = (x: BeforeAfter) => x.before.length || x.after.length;

function tagsFor(before: string, after: string, parts: SectionChange["parts"]) {
  const changed = parts.filter((p) => p.added || p.removed).map((p) => p.value).join(" ");
  const tags: SectionChange["tags"] = [];
  const amounts = { before: all(AMOUNT, before), after: all(AMOUNT, after) };
  const dates = { before: all(DATE, before), after: all(DATE, after) };
  const definedTerms = { before: all(DEFINED, before), after: all(DEFINED, after) };
  const differs = (a: string[], b: string[]) => a.join("|") !== b.join("|");
  if (differs(definedTerms.before, definedTerms.after) || (/\bmeans\b|\bdefinitions?\b/i.test(changed) && either(definedTerms))) tags.push("definitions");
  if (differs(amounts.before, amounts.after) || /appropriat/i.test(changed)) tags.push("appropriations");
  if (differs(dates.before, dates.after) || /\beffective\b/i.test(changed)) tags.push("dates");
  return { tags, amounts, dates, definedTerms };
}

// Findings state only what the text shows, never a legal effect.
export function compareVersions(beforeText: string, afterText: string): VersionComparison {
  const a = splitSections(beforeText);
  const b = splitSections(afterText);
  const labels = [...new Set([...a.map((s) => s.label), ...b.map((s) => s.label)])];
  const sections: SectionChange[] = labels.map((label) => {
    const x = a.find((s) => s.label === label);
    const y = b.find((s) => s.label === label);
    const before = x?.text ?? "";
    const after = y?.text ?? "";
    const status: SectionChange["status"] = !x ? "added" : !y ? "removed" : normalizeWs(before) === normalizeWs(after) ? "unchanged" : "modified";
    const parts =
      status === "modified"
        ? diffWords(before, after).map((p) => ({ value: p.value, added: p.added || undefined, removed: p.removed || undefined }))
        : [{ value: status === "removed" ? before : after, added: status === "added" || undefined, removed: status === "removed" || undefined }];
    return { label, heading: (y ?? x)!.heading, status, parts, ...tagsFor(before, after, parts) };
  });
  const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  for (const s of sections) counts[s.status]++;
  const findings: string[] = [];
  for (const s of sections) {
    if (s.status === "unchanged") continue;
    const name = s.heading ? `${s.label} (${s.heading})` : s.label;
    findings.push(`${name} was ${s.status}.`);
    if (s.tags.includes("appropriations") && either(s.amounts)) {
      findings.push(`${s.label}: dollar amounts ${listed(s.amounts.before)} → ${listed(s.amounts.after)}.`);
    }
    if (s.tags.includes("dates") && either(s.dates)) findings.push(`${s.label}: dates ${listed(s.dates.before)} → ${listed(s.dates.after)}.`);
    if (s.tags.includes("definitions")) {
      const { before, after } = s.definedTerms;
      const terms = (label: string, list: string[]) => (list.length ? `; ${label}: ${list.join(", ")}` : "");
      const added = terms("new terms", after.filter((t) => !before.includes(t)));
      const removed = terms("removed terms", before.filter((t) => !after.includes(t)));
      findings.push(`${s.label}: definitions changed${added}${removed}.`);
    }
  }
  return { sections, counts, findings };
}
