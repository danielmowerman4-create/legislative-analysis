// Read from pdftohtml XML: in plain text a footnote mark turns "$600" into "$6002".
import { entityChar } from "../classification/preprocess";
import { joinWrapped, squeeze } from "./connecticut";

type FiscalLine = { who: string; effect: string; amounts: string[] };
export type FiscalSide = { said: string | null; years: string[]; lines: FiscalLine[] };
export type FiscalNote = { describes: string | null; state: FiscalSide; municipal: FiscalSide; explanation: string[]; later: string | null };

type Run = { top: number; left: number; width: number; size: number; bold: boolean; text: string };
type Line = { left: number; bold: boolean; runs: Run[]; text: string };

const SAME_LINE = 4;
const INDENT = 8;
const MOST_PARAGRAPHS = 8;
const FURNITURE = /\.DOCX\b|^Page \d+ of \d+$|^Primary Analyst|^Contributing Analyst|^Reviewer:/i;
const END = /^The preceding Fiscal Impact/i;

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (m, n: string) => entityChar(Number(n), m))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const center = (r: Run) => r.left + r.width / 2;
const glue = (runs: Run[]) => squeeze(runs.map((r, i) => (i && r.left - (runs[i - 1].left + runs[i - 1].width) > 3 ? ` ${r.text}` : r.text)).join(""));

// Footnote marks print small; a line that opens with one starts the footnotes.
function pageLines(page: string, sizes: Map<string, number>) {
  const runs: Run[] = [...page.matchAll(/<text top="(\d+)" left="(\d+)" width="(\d+)" height="\d+" font="(\d+)">(.*?)<\/text>/gs)]
    .map((m) => ({
      top: Number(m[1]), left: Number(m[2]), width: Number(m[3]), size: sizes.get(m[4]) ?? 0, bold: /<b>/.test(m[5]), text: decode(m[5]),
    }))
    .filter((r) => r.text.trim())
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const rows: Run[][] = [];
  for (const r of runs) {
    const row = rows[rows.length - 1];
    if (row && r.top - row[0].top <= SAME_LINE) row.push(r);
    else rows.push([r]);
  }
  const lines: Line[] = [];
  for (const row of rows) {
    const inOrder = [...row].sort((a, b) => a.left - b.left);
    const body = Math.max(...row.map((r) => r.size));
    const isMark = (r: Run) => /^\d{1,2}(,\s*\d{1,2})*$/.test(r.text.trim()) && r.size <= body * 0.8;
    if (isMark(inOrder[0])) break;
    const kept = inOrder.filter((r) => !isMark(r));
    const text = glue(kept);
    if (!FURNITURE.test(text)) lines.push({ left: kept[0].left, bold: kept.every((r) => r.bold), runs: kept, text });
  }
  return lines;
}

// "GF - Potential Cost" -> "General Fund, potential cost", using the note's own key.
function plainEffect(effect: string, key: Map<string, string>) {
  const m = effect.match(/^([\w&,'’ ]+?)\s*[-–]\s*(.+)$/);
  if (!m) return effect.charAt(0).toUpperCase() + effect.slice(1).toLowerCase();
  const head = key.get(m[1]) ?? (/MANDATE/.test(m[1]) ? m[1].charAt(0) + m[1].slice(1).toLowerCase() : m[1]);
  return `${head}, ${m[2].toLowerCase()}`;
}

const dollars = (cell: string) => cell.replace(/(?<![\d,.$])\d[\d,.]*/g, "$$$&").replace(/\bSee Below\b/, "See below");

const unfinished = /\b(to|than|up|least|most|about|over|of|approx\.?|approximately)$/i;
const finishing = /^(million|billion|thousand|to\b)/i;
// "Potential" can be a whole amount, or the first line of "Potential / Minimal".
const continuesAmount = (above: string, cell: string) =>
  finishing.test(cell) || unfinished.test(above) || (/\bpotential$/i.test(above) && /^(minimal|significant|\$?\d)/i.test(cell));

// Cells set close together come back as one run, two spaces apart.
function splitCells(run: Run): Run[] {
  const text = run.text.trimEnd();
  const parts = text.trim().split(/\s{2,}/);
  if (parts.length < 2) return [run];
  const perChar = run.width / text.length;
  let from = 0;
  return parts.map((part) => {
    const at = text.indexOf(part, from);
    from = at + part.length;
    return { ...run, left: run.left + at * perChar, width: part.length * perChar, text: part };
  });
}

function readSide(block: Line[]): FiscalSide {
  const said = squeeze(block[0].text.replace(/^.*?Impact:/, "")).replace(/\.$/, "") || null;
  const at = block.findIndex((l) => /Effect/.test(l.text) && /\bFY\b/.test(l.text));
  if (at < 0) return { said, years: [], lines: [] };
  const header = block[at].runs;
  const effectAt = header.findIndex((r) => /Effect/.test(r.text));
  const yearRuns = header.filter((r) => /\bFY\b/.test(r.text));
  const centers = [center(header[0]), center(header[effectAt]), ...yearRuns.map(center)];
  const nearest = (r: Run) => centers.reduce((best, c, i) => (Math.abs(c - center(r)) < Math.abs(centers[best] - center(r)) ? i : best), 0);

  const noteAt = block.findIndex((l, i) => i > at && /^Note:/.test(l.text));
  const rows: string[][] = [];
  for (const line of block.slice(at + 1, noteAt < 0 ? undefined : noteAt)) {
    const cells = centers.map(() => "");
    for (const r of line.runs.flatMap(splitCells)) cells[nearest(r)] = squeeze(`${cells[nearest(r)]} ${r.text}`);
    const row = rows[rows.length - 1];
    // A row opens with name, effect and amount; anything else continues the row above.
    const carriesOn = row && cells.slice(2).some((c, i) => c && continuesAmount(row[i + 2], c));
    if (!row || (cells[0] && cells[1] && cells.slice(2).some(Boolean) && !carriesOn)) rows.push(cells);
    else cells.forEach((c, i) => (row[i] = squeeze(`${row[i]} ${c}`)));
  }
  const keyText = noteAt < 0 ? "" : block.slice(noteAt).map((l) => l.text).join(" ");
  const key = new Map([...keyText.matchAll(/([A-Z][A-Za-z&]*)\s*=\s*([^;=]+?)(?=\s*;|\s*$)/g)].map((m) => [m[1], squeeze(m[2])]));
  return {
    said,
    years: yearRuns.map((r) => squeeze(r.text.replace(/\$/g, ""))),
    lines: rows.map((c) => ({ who: c[0], effect: plainEffect(c[1], key), amounts: c.slice(2).map(dollars) })),
  };
}

const isTable = (l: Line) => l.runs.filter((r, i) => i && r.left - (l.runs[i - 1].left + l.runs[i - 1].width) > 30).length >= 2;

// Up to the first heading or table; a new paragraph starts with an indented line.
function paragraphs(lines: Line[], margin: number) {
  const out: string[] = [];
  let last: Line | null = null;
  for (const l of lines) {
    // A centered line such as "No Fiscal Impact" can sit above the first paragraph.
    if (l.bold && !out.length) continue;
    if (l.bold || isTable(l)) break;
    const indented = l.left > margin + INDENT;
    const lastIndented = last ? last.left > margin + INDENT : false;
    if (!last || (indented && (!lastIndented || /[.:;]$/.test(last.text)))) out.push(l.text);
    else out[out.length - 1] = joinWrapped(out[out.length - 1], l.text);
    last = l;
  }
  return out.map(squeeze);
}

const TABLE_TITLE = /^Table \d+\b/i;
// The tables stay in the PDF, so a sentence pointing at one points at nothing.
const withoutTableReferences = (p: string) => squeeze(p.replace(/(^|(?<=[.!?]\s))[^.!?\d]*\b(?:table|chart)s? (?:below|above)\b[^.!?\d]*[.:!?](\s|$)/gi, ""));

export function parseFiscalNote(xml: string): FiscalNote | null {
  const sizes = new Map([...xml.matchAll(/<fontspec id="(\d+)" size="(\d+)"/g)].map((m) => [m[1], Number(m[2])]));
  const lines = xml.split(/<page number="/).slice(1).flatMap((p) => pageLines(p, sizes));
  const at = (re: RegExp, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l.text));
  const start = at(/^OFA Fiscal Note/i);
  const stateAt = at(/^State Impact:/i, start);
  const municipalAt = at(/^Municipal Impact:/i, stateAt);
  const explanationAt = at(/^Explanation\b/i, municipalAt);
  if (start < 0 || stateAt < 0 || municipalAt < 0 || explanationAt < 0) return null;

  const heading = lines.slice(0, start).map((l) => l.text).join(" ");
  const amended = heading.match(/As Amended by (.+?)(?:\s*(?:House|Senate) Calendar No|$)/i)?.[1];
  const margin = lines[explanationAt].left;
  const endAt = at(END, explanationAt);
  const stop = endAt < 0 ? lines.length : endAt;
  const outAt = at(/^The Out Years\b/i, explanationAt);
  const hasLater = outAt >= 0 && outAt <= stop;

  const body = paragraphs(lines.slice(explanationAt + 1, hasLater ? outAt : stop), margin);
  const explanation = body.slice(0, MOST_PARAGRAPHS).map(withoutTableReferences).filter((p) => p && !TABLE_TITLE.test(p));
  const later = hasLater ? paragraphs(lines.slice(outAt + 1, stop), margin).join(" ") : null;
  return {
    describes: amended ? `As amended by ${squeeze(amended.replace(/\(LCO[^)]*\)/gi, "")).replace(/\s+,/g, ",")}` : null,
    state: readSide(lines.slice(stateAt, municipalAt)),
    municipal: readSide(lines.slice(municipalAt, explanationAt)),
    explanation,
    // A note with nothing to say of later years repeats its "None" lines there.
    later: later && !/^State Impact:/i.test(later) ? later : null,
  };
}
