import * as chrono from "chrono-node";
import { sentences } from "./preprocess";
import type { Evidence } from "./schema";

export type UrgencySignal = {
  category: "self_harm" | "threat" | "danger" | "deadline";
  level: "urgent" | "soon";
  summary: string;
  quote: Evidence;
  dueAt: Date | null;
};

// Plain frustration ("can't take this anymore") deliberately does not match.
export const SELF_HARM =
  /\b(suicid\w*|kill(?:ing)?\s+myself|end(?:ing)?\s+(?:my\s+(?:own\s+)?life|it\s+all)|tak(?:e|ing)\s+my\s+(?:own\s+)?life|(?:want|wish|wanted|wanting)\s+to\s+die|wish\s+i\s+(?:was|were)\s+dead|better\s+off\s+(?:dead|without\s+me)|no\s+reason\s+to\s+(?:live|go\s+on|keep\s+going)|(?:can['’]?t|cannot)\s+go\s+on\s+(?:anymore|any\s+more|any\s+longer|like\s+this|living)|(?:don['’]?t|do\s+not)\s+want\s+to\s+(?:live|be\s+here|be\s+alive|wake\s+up)|(?:don['’]?t|do\s+not)\s+see\s+a(?:ny)?\s+way\s+out|see\s+no\s+way\s+out|not\s+worth\s+living|hurt(?:ing)?\s+myself|harm(?:ing)?\s+myself|self[-\s]harm)\b/i;

const SIGNALS: { category: UrgencySignal["category"]; summary: string; re: RegExp }[] = [
  { category: "self_harm", summary: "The writer may be in danger of harming themselves", re: SELF_HARM },
  { category: "threat", summary: "Possible threat against the office or someone else", re: /\b(?:(?:i|we)(?:'ll|\s+will|\s+am\s+going\s+to|\s+are\s+going\s+to)|someone\s+(?:will|should))\s+(?:kill|shoot|hurt|harm|attack|bomb)\s+(?:you|him|her|them|the\s+(?:representative|senator)|your\s+(?:family|staff|kids|children))\b|\b(?:bomb|shoot\s+up)\s+(?:your|the)\s+(?:office|capitol|building)\b|\bwe\s+know\s+where\s+you\s+live\b|\bwatch\s+your\s+back\b/i },
  { category: "danger", summary: "The writer says someone is threatening them", re: /\b(afraid\s+for\s+my\s+life|fear\s+for\s+my\s+(?:life|safety)|threatened\s+to\s+kill\s+me|(?:he|she|they)\s+(?:will|is\s+going\s+to)\s+kill\s+me)\b/i },
];

const DEADLINE = /\b(evict\w*|foreclos\w*|shut[-\s]?off|disconnect\w*|coverage\s+(?:ends?|expires?|runs?\s+out)|benefits?\s+(?:end|ends|stop|stops|run\s+out|runs\s+out|expires?)|court\s+(?:date|hearing)|appeal\s+(?:is\s+)?due|deadline\s+(?:to|for|is)|last\s+day\s+to|surgery\s+(?:is\s+)?scheduled)\b/i;

const WHAT_IS_DUE: [RegExp, string][] = [
  [/evict/i, "facing eviction"],
  [/foreclos/i, "facing foreclosure"],
  [/shut|disconnect/i, "about to lose a utility"],
  [/coverage|benefit/i, "benefits or coverage about to end"],
  [/court/i, "has a court date"],
  [/appeal/i, "an appeal is due"],
  [/surgery/i, "has surgery scheduled"],
];

const RUNNING_OUT = /\b(?:medication|medicine|prescription|insulin|oxygen)\b[^.!?]{0,80}\b(?:run(?:s|ning)?\s+out|left)\b/i;

const URGENT_WITHIN_DAYS = 14;

export function detectUrgency(text: string, sentAt: Date, inScope: (sentence: string) => boolean = () => true): UrgencySignal[] {
  const out: UrgencySignal[] = [];
  for (const s of sentences(text)) {
    if (!inScope(s.text)) continue;
    const quote: Evidence = { start: s.start, end: s.end, text: s.text, field: "substantive" };
    const hit = SIGNALS.find((x) => x.re.test(s.text));
    if (hit) {
      out.push({ category: hit.category, level: "urgent", summary: hit.summary, quote, dueAt: null });
      continue;
    }
    if (RUNNING_OUT.test(s.text)) {
      out.push({ category: "deadline", level: "urgent", summary: "Running out of medication", quote, dueAt: null });
      continue;
    }
    const m = DEADLINE.exec(s.text);
    if (!m) continue;
    const date = chrono.parse(s.text, sentAt, { forwardDate: true })[0]?.start.date() ?? null;
    const days = date ? (date.getTime() - sentAt.getTime()) / 86400_000 : null;
    const level = days !== null && days <= URGENT_WITHIN_DAYS ? "urgent" : "soon";
    const what = `${date ? "" : "Possibly "}${WHAT_IS_DUE.find(([re]) => re.test(m[0]))?.[1] ?? "a deadline is close"}`;
    out.push({ category: "deadline", level, summary: what.replace(/^./, (c) => c.toUpperCase()), quote, dueAt: date });
  }
  return out;
}
