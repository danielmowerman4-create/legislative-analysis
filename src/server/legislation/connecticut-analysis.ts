import { joinWrapped, squeeze, titleCase } from "./connecticut";

export type BillAnalysis = {
  describes: string | null;
  summary: string[];
  effective: string | null;
  topics: { sections: string; heading: string; text: string }[];
};

const FURNITURE = /^\s*(Researcher:.*|Page \d+.*|REVISED|\d{4}[A-Z]{2}-\d+.*\.DOCX)\s*$/i;
const SECTION = /^\s*(§§?\s*[^—–]+?)\s+[—–]\s+(.+?)\s*$/;
const STOP = /^\s*(EFFECTIVE DATE:|BACKGROUND\s*$|COMMITTEE ACTION\s*$)/;

const COMMON = new Set(["AND", "THE", "FOR", "OF", "OR", "TO", "IN", "ON", "BY", "NOT", "AT", "AN", "AS", "IS", "IT"]);
const isCaps = (s: string) => s === s.toUpperCase() && /[A-Z]/.test(s);
const sectionWords = (s: string) => squeeze(s).replace(/^§§?\s*/, "");

// In these files a new paragraph starts with an indented line.
function paragraphs(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if ((/^\s{2,}\S/.test(line) && !out[out.length - 1]?.endsWith("-")) || !out.length) out.push(line.trim());
    else out[out.length - 1] = joinWrapped(out[out.length - 1], line.trim());
  }
  return out.map(squeeze);
}

export function parseAnalysis(raw: string): BillAnalysis | null {
  const lines = raw.replace(/\f/g, "\n").split("\n").filter((l) => !FURNITURE.test(l));
  const start = lines.findIndex((l) => /OLR Bill Analysis/i.test(l));
  if (start < 0) return null;
  const heading = lines.slice(start + 1).find((l) => l.trim());
  const describes = heading?.match(/\((.+)\)/)?.[1].replace(/\s+/g, " ").trim() ?? null;

  const tocAt = lines.findIndex((l) => /^\s*TABLE OF CONTENTS/i.test(l));
  // With a table of contents, "SUMMARY" appears twice: as an entry and as a heading.
  const summaries = lines.flatMap((l, i) => (/^\s*SUMMARY\s*$/.test(l) ? [i] : []));
  const summaryAt = tocAt >= 0 ? (summaries.find((i) => i > tocAt && summaries.indexOf(i) > 0) ?? -1) : (summaries[0] ?? -1);

  const topics: BillAnalysis["topics"] = [];
  if (tocAt >= 0 && summaryAt > tocAt) {
    for (const line of lines.slice(tocAt + 1, summaryAt)) {
      const t = line.trim();
      if (!t || /^(SUMMARY|BACKGROUND)$/.test(t)) continue;
      const m = !/^\s{2,}/.test(line) ? line.match(SECTION) : null;
      const open = topics[topics.length - 1];
      if (m) topics.push({ sections: sectionWords(m[1]), heading: m[2], text: "" });
      else if (open && !open.text && isCaps(t)) open.heading += ` ${t}`;
      else if (open) open.text = open.text ? joinWrapped(open.text, t) : t;
    }
  }

  let summary: string[] = [];
  let effective: string | null = null;
  if (summaryAt >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(summaryAt + 1)) {
      if (STOP.test(line) || SECTION.test(line)) break;
      body.push(line);
    }
    const paras = paragraphs(body);
    // Starred paragraphs describe amendments, not the bill as it stands.
    const firstNote = paras.findIndex((p) => p.startsWith("*"));
    summary = firstNote >= 0 ? paras.slice(0, firstNote) : paras;
    const after = lines.slice(summaryAt + 1).find((l) => /EFFECTIVE DATE:/.test(l));
    effective = after ? squeeze(after.replace(/.*EFFECTIVE DATE:/, "")).replace(/[.;]+$/, "") : null;
  }

  // Shorter analyses have no table of contents; the headings are in the text.
  if (!topics.length && summaryAt >= 0) {
    const rest = lines.slice(summaryAt + 1);
    rest.forEach((line, i) => {
      const m = !/^\s{2,}/.test(line) ? line.match(SECTION) : null;
      if (!m) return;
      const block: string[] = [];
      for (const next of rest.slice(i + 1)) {
        if (SECTION.test(next) || STOP.test(next)) break;
        block.push(next);
      }
      // Short subheads sit flush left; the text starts at the first indented line.
      const opens = block.findIndex((l) => /^\s{2,}\S/.test(l));
      const first = paragraphs(opens >= 0 ? block.slice(opens) : [])[0] ?? "";
      const sentence = first.match(/^.{40,400}?[.;](?=\s+[A-Z(]|$)/)?.[0] ?? first.slice(0, 400);
      topics.push({ sections: sectionWords(m[1]), heading: m[2], text: sentence });
    });
  }

  // OLR files a one-line stub instead of an analysis for Special Acts.
  if (/does not analyze/i.test(summary.join(" "))) return null;
  if (!summary.length && !topics.length) return null;
  // Headings are all capitals; words the body text also capitalizes are initials (DOC).
  const initials = new Set(lines.filter((l) => !isCaps(l.trim())).flatMap((l) => l.match(/\b[A-Z]{2,}\b/g) ?? []).filter((w) => !COMMON.has(w)));
  const headline = (h: string) =>
    titleCase(squeeze(h))
      .replace(/\b[A-Za-z]{2,}\b/g, (w) => (initials.has(w.toUpperCase()) ? w.toUpperCase() : w))
      .replace(/\bS(hb|sb)\b/g, (_, b: string) => `s${b.toUpperCase()}`);
  return { describes, summary, effective, topics: topics.map((t) => ({ ...t, heading: headline(t.heading) })) };
}

// Floor-amended copies first, then each file copy newest first; R00 if never given a file number.
export function documentNames(billNum: string, fileNumbers: number[], amended: boolean, kind: "BA" | "FN") {
  const stem = `2026${billNum.slice(0, 2)}-${billNum.slice(2)}`;
  const files = fileNumbers.map((f, i) => `R0${i}${String(f).padStart(4, "0")}`).reverse();
  return [...(amended ? ["R03", "R02", "R01"] : []), ...files, ...(files.length ? [] : ["R00"])].map((r) => `${stem}-${r}-${kind}.PDF`);
}
