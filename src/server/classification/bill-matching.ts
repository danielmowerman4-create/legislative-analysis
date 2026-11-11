import type { Evidence } from "./schema";
import { sentences } from "./preprocess";
import { cuesIn, resolveBill, sponsorNamed, STATE_NAME_BY_CODE, type BillCandidate, type BillMention, type BillResolution } from "./bills";

export type SessionBill = { id: string; identifier: string; billType: string; number: number; title: string; sessionIdentifier: string };
export type SessionScope = { bills: SessionBill[]; sessions: string[] };
export const NO_SESSION: SessionScope = { bills: [], sessions: [] };

const FILLER = new Set(
  `a an and are as at be but by for from had has have in into is it its of on or that the their these this those to was were will with
  act acts bill bills law laws legislation concerning relating regarding respect implementing establishing authorizing requiring providing
  prohibiting revising amending creating certain various other purposes resolution proposing confirming approving state`.split(/\s+/),
);
const CUE = new Set(["bill", "act", "law", "legislation", "measure", "proposal", "resolution"]);

function stemWord(w: string) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (/(?:x|ch|sh|ss)es$/.test(w)) return w.slice(0, -2);
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") ? w.slice(0, -1) : w;
}

type Token = { word: string; filler: boolean; start: number; end: number };

function tokenize(text: string, offset = 0): Token[] {
  return [...text.matchAll(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g)].map((m) => {
    const clean = m[0].toLowerCase().replace(/['’]s?$/, "").replace(/['’]/g, "");
    return { word: stemWord(clean), filler: FILLER.has(clean) || clean.length < 2, start: m.index + offset, end: m.index + offset + m[0].length };
  });
}

const significantWords = (text: string) => tokenize(text).filter((t) => !t.filler).map((t) => t.word);

// Swapping two neighbors counts as one edit, so 142 and 124 are one apart.
function editDistance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export type BillNameIndex = {
  entries: { bill: SessionBill; words: string[]; literal: string }[];
  byWord: Map<string, number[]>;
  byFirstLetter: Map<string, string[]>;
  count: number;
};

const collapse = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();

export function buildBillNameIndex(bills: SessionBill[]): BillNameIndex {
  const entries = bills.map((bill) => ({ bill, words: significantWords(bill.title), literal: collapse(bill.title) }));
  const byWord = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const w of new Set(e.words)) byWord.set(w, [...(byWord.get(w) ?? []), i]);
  });
  const byFirstLetter = new Map<string, string[]>();
  for (const w of byWord.keys()) byFirstLetter.set(w[0], [...(byFirstLetter.get(w[0]) ?? []), w]);
  return { entries, byWord, byFirstLetter, count: bills.length };
}

function spellcheck(index: BillNameIndex, word: string) {
  if (index.byWord.has(word) || word.length < 5 || /\d/.test(word)) return word;
  const close = (index.byFirstLetter.get(word[0]) ?? []).filter((v) => Math.abs(v.length - word.length) <= 1 && editDistance(v, word) === 1);
  return close.length === 1 ? close[0] : word;
}

export type NameMatch = { raw: string; evidence: Evidence[]; bills: SessionBill[]; strength: "named" | "suggested" };

type Hit = { entry: number; start: number; length: number };

function runsIn(index: BillNameIndex, words: string[]) {
  const best = new Map<number, Hit>();
  words.forEach((word, i) => {
    for (const entry of index.byWord.get(word) ?? []) {
      const title = index.entries[entry].words;
      title.forEach((t, j) => {
        if (t !== word || (i > 0 && j > 0 && title[j - 1] === words[i - 1])) return;
        let length = 1;
        while (i + length < words.length && j + length < title.length && words[i + length] === title[j + length]) length++;
        const current = best.get(entry);
        if (!current || length > current.length) best.set(entry, { entry, start: i, length });
      });
    }
  });
  return [...best.values()];
}

function scanSegment(index: BillNameIndex, text: string, offset: number, field: "substantive" | "subject", officeState: string, out: Map<string, NameMatch>) {
  const all = tokenize(text, offset);
  const words = all.flatMap((t, at) => (t.filler ? [] : [{ word: spellcheck(index, t.word), at }]));
  const plain = words.map((w) => w.word);
  const hits = runsIn(index, plain);

  const judged = hits.flatMap((h) => {
    const { words: title } = index.entries[h.entry];
    const run = plain.slice(h.start, h.start + h.length);
    const firstAt = words[h.start].at;
    const lastAt = words[h.start + h.length - 1].at;
    const near = [...all.slice(lastAt + 1, lastAt + 3), ...all.slice(Math.max(0, firstAt - 4), firstAt)];
    const cue = near.some((t) => CUE.has(t.word));
    const sharing = hits.filter((o) => o.start <= h.start && o.start + o.length >= h.start + h.length).length;
    const rarest = Math.min(...run.map((w) => index.byWord.get(w)?.length ?? 0));
    const share = h.length / title.length;
    const whole = h.length === title.length;
    let strength: NameMatch["strength"] | null = null;
    if (whole && h.length >= 3) strength = "named";
    else if (whole && h.length === 2) strength = cue ? "named" : rarest <= 2 ? "suggested" : null;
    else if (h.length >= 3 && cue && sharing === 1) strength = "named";
    else if (h.length >= 4 && share >= 0.5 && sharing === 1) strength = "named";
    else if (h.length >= 3 && share >= 0.6 && rarest <= 2) strength = "suggested";
    else if (h.length === 2 && cue && sharing <= 3 && rarest <= 2 && share >= 0.4) strength = "suggested";
    return strength ? [{ ...h, strength, whole }] : [];
  });

  const groups: { start: number; length: number; hits: typeof judged }[] = [];
  for (const h of [...judged].sort((a, b) => b.length - a.length)) {
    const overlapping = groups.find((g) => h.start < g.start + g.length && g.start < h.start + h.length);
    if (!overlapping) groups.push({ start: h.start, length: h.length, hits: [h] });
    else if (overlapping.start === h.start && overlapping.length === h.length) overlapping.hits.push(h);
  }

  for (const g of groups) {
    const wholeTitles = g.hits.filter((h) => h.whole);
    const chosen = wholeTitles.length ? wholeTitles : g.hits;
    const start = all[words[g.start].at].start;
    const end = all[words[g.start + g.length - 1].at].end;
    const raw = text.slice(start - offset, end - offset);
    // Judged on the rest of the sentence: some state bill titles say "Federal".
    const cues = cuesIn(`${text.slice(0, start - offset)} ${text.slice(end - offset)}`);
    if (cues.federal || cues.otherStates.some((s) => s !== officeState)) continue;
    const bills = chosen.map((h) => index.entries[h.entry].bill);
    const key = bills.map((b) => b.id).sort().join(",");
    const strength = chosen.some((h) => h.strength === "named") ? "named" : "suggested";
    const evidence: Evidence = { start, end, text: raw, field };
    const existing = out.get(key);
    if (existing) {
      existing.evidence.push(evidence);
      if (strength === "named") existing.strength = "named";
    } else out.set(key, { raw, evidence: [evidence], bills, strength });
  }
}

function scanLiteralTitles(index: BillNameIndex, text: string, field: "substantive" | "subject", out: Map<string, NameMatch>) {
  const lower = text.toLowerCase();
  for (const e of index.entries) {
    if (e.words.length !== 1 || e.literal.split(" ").length < 3) continue;
    const at = lower.indexOf(e.literal);
    if (at < 0) continue;
    const raw = text.slice(at, at + e.literal.length);
    out.set(e.bill.id, { raw, evidence: [{ start: at, end: at + e.literal.length, text: raw, field }], bills: [e.bill], strength: "named" });
  }
}

export function findBillNames(substantive: string, subject: string, index: BillNameIndex, officeJurisdiction: string): NameMatch[] {
  if (!index.count) return [];
  const officeState = STATE_NAME_BY_CODE[officeJurisdiction] ?? officeJurisdiction;
  const out = new Map<string, NameMatch>();
  for (const s of sentences(substantive)) scanSegment(index, s.text, s.start, "substantive", officeState, out);
  if (subject) scanSegment(index, subject, 0, "subject", officeState, out);
  scanLiteralTitles(index, substantive, "substantive", out);
  return [...out.values()];
}

const CHAMBER_TWIN: Record<string, string> = { HB: "SB", SB: "HB", HR: "SR", SR: "HR", HJ: "SJ", SJ: "HJ", HJR: "SJR", SJR: "HJR", HF: "SF", SF: "HF" };
const SAME_KIND: Record<string, string> = { HJR: "HJ", SJR: "SJ", HJ: "HJR", SJ: "SJR" };
const ONE_LETTER_OFF: Record<string, string> = { HB: "HR", HR: "HB", SB: "SR", SR: "SB" };

// Lower is closer; null means not plausibly the same bill.
export function numberCloseness(m: Pick<BillMention, "billType" | "number" | "bare">, b: Pick<SessionBill, "billType" | "number">): number | null {
  if (m.bare) return b.number === m.number ? 0 : null;
  if (b.number === m.number) {
    if (b.billType === m.billType) return 0;
    if (SAME_KIND[m.billType] === b.billType || CHAMBER_TWIN[m.billType] === b.billType) return 1;
    return ONE_LETTER_OFF[m.billType] === b.billType ? 3 : null;
  }
  if (b.billType !== m.billType && SAME_KIND[m.billType] !== b.billType) return null;
  const written = String(m.number);
  const actual = String(b.number);
  if (editDistance(written, actual) !== 1) return null;
  if (written.length !== actual.length) return 3;
  return [...written].sort().join("") === [...actual].sort().join("") ? 1 : 2;
}

function closeBills(m: BillMention, bills: SessionBill[]) {
  return bills.flatMap((b) => {
    const close = b.identifier === m.reference ? null : numberCloseness(m, b);
    return close === null ? [] : [{ bill: b, close }];
  });
}

export function referencesToLoad(numbers: BillMention[], names: NameMatch[], scope: SessionScope) {
  const refs = new Set<string>();
  for (const m of numbers) {
    if (!m.bare) refs.add(m.reference);
    for (const { bill } of closeBills(m, scope.bills)) refs.add(bill.identifier);
  }
  for (const n of names) for (const b of n.bills) refs.add(b.identifier);
  return [...refs];
}

export type MatchedMention = { mention: BillMention; resolution: BillResolution; suggested?: boolean };

type Fit = { shared: number; rare: number; strong: boolean };

function makeFit(index: BillNameIndex, candidates: BillCandidate[], ctx: { substantive: string; subject: string }) {
  const email = new Set([...significantWords(ctx.substantive), ...significantWords(ctx.subject)]);
  const text = `${ctx.subject}\n${ctx.substantive}`.toLowerCase();
  const rareAt = Math.max(2, Math.ceil(index.count * 0.01));
  return (b: SessionBill): Fit => {
    const title = [...new Set(significantWords(b.title))];
    const hits = title.filter((w) => email.has(w));
    let rare = hits.filter((w) => (index.byWord.get(w)?.length ?? 0) <= rareAt).length;
    const sponsors = candidates.find((c) => c.id === b.id)?.sponsorNames ?? [];
    if (sponsorNamed(sponsors, text)) rare++;
    const strong = rare >= 2 || (hits.length >= 3 && rare >= 1) || (hits.length >= 2 && hits.length / title.length >= 0.5 && rare >= 1);
    return { shared: hits.length, rare, strong };
  };
}

const shortTitle = (b: SessionBill) => (b.title.length > 70 ? `${b.title.slice(0, 67)}...` : b.title);

function rename(m: BillMention, b: SessionBill): BillMention {
  return { ...m, reference: b.identifier, billType: b.billType, number: b.number, bare: false };
}

const adjacent = (a: Evidence[], b: Evidence[]) =>
  a.some((x) => b.some((y) => x.field === y.field && Math.min(Math.abs(x.end - y.start), Math.abs(y.end - x.start)) <= 40));

export function resolveMentions(input: {
  numbers: BillMention[];
  names: NameMatch[];
  candidates: BillCandidate[];
  scope: SessionScope;
  index: BillNameIndex;
  ctx: { officeJurisdiction: string; messageDate: Date; substantive: string; subject: string; issueKeys: string[]; currentSessions?: string[] };
}): MatchedMention[] {
  const { numbers, names, candidates, scope, index, ctx } = input;
  const fit = makeFit(index, candidates, ctx);
  const out: MatchedMention[] = [];

  const named = names.map((n) => {
    const single = n.strength === "named" && n.bills.length === 1 ? n.bills[0] : null;
    return { match: n, single, writtenAs: null as string | null, extra: [] as Evidence[] };
  });

  const ambiguous = (m: BillMention, bills: SessionBill[], confidence: number, notes: string): MatchedMention => ({
    mention: m,
    resolution: { reference: m.reference, billId: null, candidateIds: bills.map((b) => b.id), status: "ambiguous", confidence, notes },
  });
  const corrected = (m: BillMention, b: SessionBill, confidence: number, notes: string): MatchedMention => ({
    mention: rename(m, b),
    resolution: { reference: b.identifier, billId: b.id, candidateIds: [b.id], status: "resolved", confidence, notes },
  });

  for (const m of numbers) {
    if (m.bare) {
      const same = scope.bills.filter((b) => b.number === m.number);
      if (!same.length) continue;
      const scored = same.map((b) => ({ b, f: fit(b) })).sort((x, y) => y.f.rare - x.f.rare || y.f.shared - x.f.shared);
      const clear = scored.filter((s) => s.f.strong);
      if (same.length === 1 || clear.length === 1) {
        const pick = clear[0]?.b ?? same[0];
        const supported = clear.length === 1 || fit(pick).rare >= 1;
        const notes = `Wrote "${m.raw}" with no chamber. The only match this session is ${pick.identifier}, ${shortTitle(pick)}.`;
        out.push(corrected(m, pick, supported ? 0.96 : 0.9, notes));
      } else out.push(ambiguous(m, same.slice(0, 5), 0.4, `"${m.raw}" could be ${same.slice(0, 5).map((b) => b.identifier).join(" or ")}.`));
      continue;
    }

    const exact = resolveBill(m, candidates, ctx);
    if (exact.status === "out_of_jurisdiction" || !scope.bills.length) {
      out.push({ mention: m, resolution: exact });
      continue;
    }
    const settled = exact.status === "resolved" && exact.confidence >= 0.95;

    const besideName = named.find(
      (n) => n.single && n.single.id !== exact.billId && adjacent(m.evidence, n.match.evidence) && numberCloseness(m, n.single) !== null,
    );
    if (besideName && !settled) {
      besideName.writtenAs = m.raw;
      besideName.extra.push(...m.evidence);
      continue;
    }
    if (settled || exact.status === "ambiguous") {
      out.push({ mention: m, resolution: exact });
      continue;
    }

    const near = closeBills(m, scope.bills).map((c) => ({ ...c, fit: fit(c.bill) }));
    const strong = near.filter((c) => c.fit.strong).sort((a, b) => b.fit.rare - a.fit.rare || b.fit.shared - a.fit.shared || a.close - b.close);

    if (exact.status === "resolved") {
      const own = scope.bills.find((b) => b.id === exact.billId);
      if (own && strong.length && fit(own).rare === 0) {
        const notes = `${m.reference} is ${shortTitle(own)}, but this message reads like ${strong[0].bill.identifier}, ${shortTitle(strong[0].bill)}.`;
        out.push(ambiguous(m, [strong[0].bill, own], 0.5, notes));
      } else out.push({ mention: m, resolution: exact });
      continue;
    }

    const leader = strong[0];
    if (leader && (!strong[1] || leader.fit.rare > strong[1].fit.rare || leader.fit.shared > strong[1].fit.shared)) {
      const bill = `${leader.bill.identifier}, ${shortTitle(leader.bill)}`;
      out.push(corrected(m, leader.bill, 0.96, `Wrote ${m.raw}, which is not a bill this session. Read as ${bill}, because the message uses its words.`));
      continue;
    }
    if (strong.length) {
      const picks = strong.slice(0, 3).map((s) => s.bill);
      out.push(ambiguous(m, picks, 0.45, `No ${m.reference} this session. Could be ${picks.map((b) => b.identifier).join(" or ")}.`));
      continue;
    }
    const closest = near.filter((c) => c.close <= 2).sort((a, b) => a.close - b.close);
    if (closest.length >= 1 && closest.length <= 3) {
      const picks = closest.map((c) => c.bill);
      out.push(ambiguous(m, picks, 0.35, `No ${m.reference} this session. Could be ${picks.map((b) => b.identifier).join(" or ")}.`));
      continue;
    }
    out.push({ mention: m, resolution: exact });
  }

  const claimed = new Set(out.flatMap((r) => r.resolution.candidateIds));
  for (const n of named) {
    const { match, single, writtenAs, extra } = n;
    if (!single && match.bills.some((b) => claimed.has(b.id))) continue;
    const evidence = [...match.evidence, ...extra];
    if (single) {
      const name = `${single.identifier}, ${shortTitle(single)}`;
      const notes = writtenAs ? `Wrote ${writtenAs}, but called it by name: ${name}.` : `Called by name: ${name}.`;
      out.push({
        mention: {
          raw: writtenAs ?? match.raw, reference: single.identifier, billType: single.billType, number: single.number,
          evidence, federalContext: false, otherStates: [],
        },
        resolution: { reference: single.identifier, billId: single.id, candidateIds: [single.id], status: "resolved", confidence: 0.97, notes },
      });
      continue;
    }
    const reference = match.raw.replace(/\s+/g, " ").slice(0, 80);
    const list = match.bills.slice(0, 5);
    out.push({
      mention: { raw: match.raw, reference, billType: "", number: 0, evidence, federalContext: false, otherStates: [] },
      resolution: {
        reference, billId: null, candidateIds: list.map((b) => b.id), status: "ambiguous", confidence: 0.7,
        notes: `Reads like ${list.map((b) => `${b.identifier}, ${shortTitle(b)}`).join(" or ")}.`,
      },
      suggested: match.strength === "suggested",
    });
  }

  const merged = new Map<string, MatchedMention>();
  for (const r of out) {
    const key = r.resolution.reference;
    const held = merged.get(key);
    if (!held) {
      merged.set(key, r);
      continue;
    }
    const winner = r.resolution.confidence > held.resolution.confidence ? r : held;
    const other = winner === r ? held : r;
    const seen = new Set(winner.mention.evidence.map((e) => `${e.field}:${e.start}`));
    winner.mention.evidence.push(...other.mention.evidence.filter((e) => !seen.has(`${e.field}:${e.start}`)));
    if (/\d/.test(other.mention.raw) && !/\d/.test(winner.mention.raw)) winner.mention.raw = other.mention.raw;
    merged.set(key, winner);
  }
  return [...merged.values()];
}
