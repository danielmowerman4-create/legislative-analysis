import type { Evidence } from "./schema";
import { escapeRe } from "./issues";
import { sentences } from "./preprocess";
import { normalizeBillIdentifier, normalizeBillType } from "../legislation/normalize";

export type BillMention = {
  raw: string;
  reference: string;
  billType: string;
  number: number;
  evidence: Evidence[];
  federalContext: boolean;
  otherStates: string[];
  // Written with no chamber, like "Bill 142" or "Raised Bill 5001".
  bare?: boolean;
};

// HB142, H.B. 142, HB-142, hb #142, House Bill No. 142, sHB 5001, 5,001
const SEP = String.raw`[.\s-]*`;
const NO = String.raw`(?:(?:[Nn][Oo]|[Nn]umber|[Nn]um)\b\.?\s*|#\s*)?`;
const NUM = String.raw`(\d{1,3},\d{3}|\d{1,5})\b`;
const LETTERS = String.raw`H\.?\s?J\.?\s?R|S\.?\s?J\.?\s?R|H\.?\s?B|S\.?\s?B|H\.?\s?J|S\.?\s?J|H\.?\s?R|S\.?\s?R|A\.?\s?B|L\.?\s?B|H\.?\s?F|S\.?\s?F`;
const ABBREV = new RegExp(String.raw`(?<![\w.])[sS]?(${LETTERS})${SEP}${NO}${NUM}`, "g");
// Only these two in lower case: "lb 40" is pounds and "hr 12" is hours.
const LOWERCASE = new RegExp(String.raw`(?<![\w.])([hs]\.?\s?b)${SEP}${NO}${NUM}`, "gi");
const LONG = new RegExp(String.raw`\b(House|Hosue|Houes|Huose|Senate|Sentate|Senat|Assembly)[\s-]+(Joint\s+Resolution|Bill|Bil|Resolution)${SEP}${NO}${NUM}`, "gi");
const BARE = new RegExp(String.raw`(?<![\w-])(?:(?:Raised|Proposed|Substitute|Committee)\s+)?Bill${SEP}${NO}${NUM}`, "gi");
const NOT_LEGISLATION_BEFORE = /\b(?:house|hosue|houes|huose|senate|sentate|senat|assembly|joint|electric|power|gas|water|phone|cable|medical|hospital|tax|utility|light|sewer|insurance|rent|my|our|this\s+month'?s?)\s+$/;
const NOT_LEGISLATION_AFTER = /^\s*(?:\.\d|%|dollars?\b|cents?\b|bucks?\b|per\b|a\s+month\b|days?\b|months?\b|years?\b)/;

export const STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida",
  GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
  MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", ZZ: "Demo State",
};
const STATE_RE = new RegExp(`\\b(${Object.values(STATE_NAME_BY_CODE).map((s) => s.replace(/ /g, "\\s+")).join("|")})(?:['’]s)?\\b`, "g");
const FEDERAL_RE = /\b(Congress|congressional|U\.?S\.?\s+(House|Senate)|federal|Senator\s+\w+\s+in\s+Washington|Capitol Hill|U\.S\. Representative)\b/i;

// "I am writing from Texas": where the writer is, not whose bill it is.
const WRITER_IS_IN = /(?:\bfrom|\bliv(?:e|es|ed|ing)\s+in|\bresidents?\s+of|\bmoved\s+(?:to|from)|\bhere\s+in|\bborn\s+in|\bvisiting(?:\s+from)?|\bbased\s+in)\s+$/i;

export function cuesIn(sentence: string) {
  const otherStates = [...sentence.matchAll(STATE_RE)].filter((m) => !WRITER_IS_IN.test(sentence.slice(0, m.index))).map((m) => m[1].replace(/\s+/g, " "));
  return { federal: FEDERAL_RE.test(sentence), otherStates };
}

export function extractBillMentions(substantive: string, subject: string): BillMention[] {
  const byRef = new Map<string, BillMention>();
  const sents = sentences(substantive);
  const scan = (text: string, field: "substantive" | "subject") => {
    const add = (raw: string, type: string, written: string, index: number, bare = false) => {
      const num = written.replace(/,/g, "");
      const reference = bare ? `Bill ${Number(num)}` : normalizeBillIdentifier(type, num);
      const ev: Evidence = { start: index, end: index + raw.length, text: raw, field };
      const sentence = field === "substantive" ? sents.find((s) => index >= s.start && index < s.end)?.text ?? "" : text;
      const { federal, otherStates } = cuesIn(sentence);
      const existing = byRef.get(reference);
      if (existing) {
        if (!existing.evidence.some((e) => e.field === field && e.start === index)) existing.evidence.push(ev);
        existing.federalContext ||= federal;
        existing.otherStates.push(...otherStates.filter((s) => !existing.otherStates.includes(s)));
      } else {
        const billType = bare ? "" : normalizeBillType(type);
        byRef.set(reference, { raw, reference, billType, number: Number(num), evidence: [ev], federalContext: federal, otherStates, bare });
      }
    };
    for (const m of text.matchAll(ABBREV)) add(m[0], m[1], m[2], m.index!);
    for (const m of text.matchAll(LOWERCASE)) add(m[0], m[1], m[2], m.index!);
    for (const m of text.matchAll(LONG)) {
      const chamber = /^h/i.test(m[1]) ? "House" : /^s/i.test(m[1]) ? "Senate" : "Assembly";
      add(m[0], `${chamber} ${/^bil/i.test(m[2]) ? "Bill" : m[2]}`, m[3], m.index!);
    }
    for (const m of text.matchAll(BARE)) {
      const before = text.slice(Math.max(0, m.index! - 24), m.index!).toLowerCase();
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 12).toLowerCase();
      if (!NOT_LEGISLATION_BEFORE.test(before) && !NOT_LEGISLATION_AFTER.test(after)) add(m[0], "", m[1], m.index!, true);
    }
  };
  scan(substantive, "substantive");
  scan(subject, "subject");
  return [...byRef.values()];
}

export type BillCandidate = {
  id: string;
  identifier: string;
  jurisdictionCode: string;
  sessionIdentifier: string;
  sessionStart: string | null;
  sessionEnd: string | null;
  title: string;
  summary?: string | null;
  subjects: string[];
  sponsorNames: string[];
};

export type BillResolution = {
  reference: string;
  billId: string | null;
  candidateIds: string[];
  status: "resolved" | "ambiguous" | "unmatched" | "out_of_jurisdiction";
  confidence: number;
  notes: string;
};

const STOP = new Set(
  "a an and are as at be bill by for from has have i in is it its law of on or our please that the their this to vote was we were will with would you your act state house senate support oppose am my me not no yes".split(" "),
);
const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).map(stem));

const TOPIC_STEMS: Record<string, string[]> = {
  education: ["educat", "school", "student", "teacher"],
  transportation: ["transport", "road", "highway", "motor vehicle", "traffic", "transit"],
  healthcare: ["health", "medic", "hospital", "pharma", "drug"],
  taxes: ["tax", "revenue", "budget", "appropriation", "finance"],
  public_safety: ["crime", "criminal", "police", "firearm", "weapon", "law enforcement", "correction", "court", "public safety"],
  economy: ["labor", "employ", "business", "commerce", "economic", "wage"],
  housing: ["housing", "landlord", "tenant", "real property", "zoning", "real estate"],
  environment: ["environment", "energy", "water", "natural resource", "conservation", "utilit", "pollution"],
  elections: ["election", "voting", "voter", "ethics", "campaign"],
  social_services: ["human services", "welfare", "child", "family", "aging", "disabilit", "social services"],
  veterans: ["veteran", "military"],
  immigration: ["immigra"],
  civil_rights: ["civil rights", "discriminat"],
  agriculture: ["agricultur", "farm", "broadband", "rural"],
  consumer: ["consumer", "insurance", "gaming", "gambling", "lottery"],
};

function subjectsMatchIssues(subjects: string[], issueKeys: string[]) {
  const areas = new Set(issueKeys.map((k) => k.split(".")[0]));
  return subjects.some((s) => {
    const lower = s.toLowerCase();
    return [...areas].some((a) => lower === a || (TOPIC_STEMS[a] ?? []).some((stem) => lower.includes(stem)));
  });
}

export function sponsorNamed(sponsorNames: string[], text: string) {
  return sponsorNames.map((n) => n.split(/\s+/).pop()!.toLowerCase()).find((last) => last.length > 2 && new RegExp(`\\b${escapeRe(last)}\\b`).test(text));
}

function sessionActiveAt(c: Pick<BillCandidate, "sessionStart" | "sessionEnd">, at: Date, graceDays = 75) {
  if (!c.sessionStart && !c.sessionEnd) return true;
  const start = c.sessionStart ? new Date(`${c.sessionStart}T00:00:00Z`).getTime() : -Infinity;
  const end = c.sessionEnd ? new Date(`${c.sessionEnd}T23:59:59Z`).getTime() + graceDays * 86400_000 : Infinity;
  return at.getTime() >= start - 30 * 86400_000 && at.getTime() <= end;
}

export function sessionsInScope<T extends { startDate: string | null; endDate: string | null }>(sessions: T[], at: Date): T[] {
  const active = sessions.filter((s) => sessionActiveAt({ sessionStart: s.startDate, sessionEnd: s.endDate }, at));
  if (active.length) return active;
  const started = sessions.filter((s) => s.startDate && new Date(`${s.startDate}T00:00:00Z`).getTime() <= at.getTime());
  return started.sort((a, b) => b.startDate!.localeCompare(a.startDate!)).slice(0, 1);
}

export function resolveBill(
  mention: BillMention,
  candidates: BillCandidate[],
  ctx: { officeJurisdiction: string; messageDate: Date; substantive: string; issueKeys: string[]; currentSessions?: string[] },
): BillResolution {
  const officeState = STATE_NAME_BY_CODE[ctx.officeJurisdiction] ?? ctx.officeJurisdiction;
  const unlinked = (status: BillResolution["status"], confidence: number, notes: string, candidateIds: string[] = []): BillResolution => ({
    reference: mention.reference, billId: null, candidateIds, status, confidence, notes,
  });
  if (mention.federalContext) return unlinked("out_of_jurisdiction", 0.9, "Federal context (Congress / U.S. House or Senate) in the same sentence.");
  const foreign = mention.otherStates.filter((s) => s !== officeState);
  if (foreign.length && !mention.otherStates.includes(officeState)) {
    return unlinked("out_of_jurisdiction", 0.9, `Refers to ${foreign.join(", ")} legislation, not ${officeState}.`);
  }
  const inJurisdiction = candidates.filter((c) => c.jurisdictionCode === ctx.officeJurisdiction && c.identifier === mention.reference);
  const active = inJurisdiction.filter((c) => sessionActiveAt(c, ctx.messageDate) || ctx.currentSessions?.includes(c.sessionIdentifier));
  if (inJurisdiction.length === 0) {
    const notes = `No ${mention.reference} found in ${officeState} legislative data. It may be from another session or state, or the source has not synced it.`;
    return unlinked("unmatched", 0, notes);
  }
  if (active.length === 0) {
    const sessions = inJurisdiction.map((c) => c.sessionIdentifier).join(", ");
    const notes = `${mention.reference} exists only in sessions not active when this message was sent (${sessions}).`;
    return unlinked("ambiguous", 0.4, notes, inJurisdiction.map((c) => c.id));
  }
  if (active.length > 1) {
    const notes = `${active.length} bills numbered ${mention.reference} were active (${active.map((c) => c.sessionIdentifier).join(", ")}). Staff must choose.`;
    return unlinked("ambiguous", 0.3, notes, active.map((c) => c.id));
  }
  const c = active[0];
  const text = ctx.substantive.toLowerCase();
  const corroboration: string[] = [];
  if (mention.otherStates.includes(officeState)) corroboration.push(`${officeState} named`);
  const titleWords = words(c.title);
  const officialWords = words(`${c.title} ${c.summary ?? ""}`);
  const bodyWords = words(ctx.substantive);
  const sharedTitle = [...titleWords].filter((w) => bodyWords.has(w));
  const shared = [...officialWords].filter((w) => bodyWords.has(w));
  const titleShare = titleWords.size > 0 && sharedTitle.length / titleWords.size >= 0.25;
  if (shared.length >= 2 || titleShare) corroboration.push(`title or summary words: ${shared.slice(0, 4).join(", ")}`);
  const sponsor = sponsorNamed(c.sponsorNames, text);
  if (sponsor) corroboration.push(`sponsor named (${sponsor})`);
  const subjectOverlap = subjectsMatchIssues(c.subjects, ctx.issueKeys);
  if (subjectOverlap) corroboration.push("subject matches tagged issue");
  const year = c.sessionIdentifier.match(/\d{4}/)?.[0];
  if (year && text.includes(year)) corroboration.push(`session year ${year} mentioned`);

  const topicConflict = ctx.issueKeys.length > 0 && c.subjects.length > 0 && !subjectOverlap && shared.length === 0;
  // A lone match this session is accepted (0.95) unless the topic points away.
  let confidence = corroboration.length ? 0.96 + 0.015 * (Math.min(corroboration.length, 3) - 1) : 0.95;
  if (topicConflict) confidence = 0.6;
  return {
    reference: mention.reference,
    billId: c.id,
    candidateIds: [c.id],
    status: "resolved",
    confidence: Number(confidence.toFixed(3)),
    notes: topicConflict
      ? `Only ${mention.reference} in ${c.sessionIdentifier}, but the message topic does not match the bill ("${c.title.slice(0, 80)}"). Verify.`
      : corroboration.length
        ? `Only ${mention.reference} in the ${c.sessionIdentifier} session; corroborated by ${corroboration.join("; ")}.`
        : `Only ${mention.reference} in the ${c.sessionIdentifier} session.`,
  };
}
