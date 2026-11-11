import { sentences } from "./preprocess";
import { MEDIA, MEETING, SERVICE, SERVICE_ES } from "./rules";
import type { ClassificationResult, Evidence, MessageTypeKey } from "./schema";
import type { UrgencySignal } from "./urgency";

export type Ask = ClassificationResult["asks"][number];

const INFORMATION = /\b(what\s+is\s+the\s+status|status\s+of|more\s+information\s+(?:about|on)|can\s+you\s+(?:send|explain|tell)|how\s+(?:does|would)\s+(?:this|the)\s+bill|when\s+will\s+(?:the|this)\s+(?:bill|vote|hearing)|where\s+do\s+you\s+stand|how\s+(?:will|do)\s+you\s+(?:plan\s+to\s+)?vote|who\s+is\s+responsible|which\s+(?:agency|office|department))\b/i;
const FOLLOW_UP = /\b(get\s+back\s+to\s+me|call\s+me|contact\s+me|reach\s+me\s+at|hear\s+back|please\s+(?:respond|reply))\b/i;

const POSITION_WORD: Record<string, string> = { support: "Supports", oppose: "Opposes", mixed: "Has mixed views on", neutral: "Asks about" };

export function extractAsks(input: {
  text: string; types: MessageTypeKey[]; positions: ClassificationResult["positions"]; caseCategory: string | null; signals: UrgencySignal[];
  inScope: (s: string) => boolean; isFormLetter: boolean;
}): Ask[] {
  const { text, types, positions, caseCategory, signals, inScope, isFormLetter } = input;
  const asks: Ask[] = signals.map((s) => ({
    kind: s.category === "deadline" ? "deadline" : "safety", summary: s.summary, urgency: s.level, due_at: s.dueAt?.toISOString() ?? null,
    source: "rule", evidence: s.quote,
  }));
  const parts = sentences(text).filter((s) => inScope(s.text));
  const firstMatch = (re: RegExp) => parts.find((s) => re.test(s.text));
  const add = (kind: Ask["kind"], summary: string, s: { text: string; start: number; end: number } | undefined) => {
    if (!s || asks.some((a) => a.kind === kind && a.evidence.start === s.start)) return;
    const evidence: Evidence = { start: s.start, end: s.end, text: s.text, field: "substantive" };
    asks.push({ kind, summary, urgency: "routine", due_at: null, source: "rule", evidence });
  };

  // A form letter's stance counts on its own page; only a personal note asks here.
  if (types.includes("constituent_service") || isFormLetter) {
    add("casework", caseCategory ? `Asks for help: ${caseCategory}` : "Asks for help with a government service", firstMatch(SERVICE) ?? firstMatch(SERVICE_ES));
  }
  if (types.includes("meeting_request")) add("meeting", "Asks to meet", firstMatch(MEETING));
  if (types.includes("media")) add("other", "Press inquiry", firstMatch(MEDIA));
  add("information", "Asks for information", firstMatch(INFORMATION));
  add("follow_up", "Expects a response", firstMatch(FOLLOW_UP));

  if (!isFormLetter) {
    for (const p of positions) {
      if (p.target_type !== "bill" || p.position === "unclear") continue;
      const ev: Evidence | undefined = p.evidence[0];
      if (!ev || ev.field === "subject" || asks.some((a) => a.kind === "position" && a.evidence.start === ev.start)) continue;
      const summary = `${POSITION_WORD[p.position]} ${p.bill_reference}`;
      asks.push({ kind: "position", summary, urgency: "routine", due_at: null, source: "rule", evidence: ev });
    }
  }
  return asks;
}
