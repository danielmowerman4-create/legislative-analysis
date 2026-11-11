import { z } from "zod";

export const PIPELINE_VERSION = "2026.11.9";

export const MESSAGE_TYPES = [
  "constituent_policy",
  "constituent_service",
  "meeting_request",
  "constituent_general",
  "government_agency",
  "legislative_staff",
  "organization",
  "newsletter_automated",
  "media",
  "vendor",
  "advocacy_lobbyist",
  "spam",
  "other",
] as const;

export const POSITIONS = ["support", "oppose", "mixed", "neutral", "unclear"] as const;
export const REQUESTED_ACTIONS = ["policy_response", "agency_assistance", "meeting", "legislation_info", "follow_up", "referral", "none"] as const;
const BILL_RESOLUTIONS = ["resolved", "ambiguous", "unmatched", "out_of_jurisdiction"] as const;
export const BILL_REQUESTS = ["vote_yes", "vote_no", "amend", "cosponsor", "hearing", "information"] as const;
export const ASK_KINDS = ["casework", "position", "meeting", "information", "follow_up", "safety", "deadline", "other"] as const;
export const ASK_URGENCY = ["routine", "soon", "urgent"] as const;

const evidenceSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string().min(1),
  field: z.enum(["substantive", "subject"]).optional(),
});

export const classificationSchema = z.object({
  pipeline_version: z.string(),
  mode: z.enum(["rules", "rules+ai"]),
  language: z.string().nullable(),
  message_type: z.array(z.object({ type: z.enum(MESSAGE_TYPES), confidence: z.number().min(0).max(1), signals: z.array(z.string()) })).min(1),
  summary: z.string().min(1).max(600),
  summary_source: z.enum(["rule", "ai"]),
  issues: z.array(
    z.object({
      taxonomy_id: z.string(),
      confidence: z.number().min(0).max(1),
      source: z.enum(["rule", "ai", "ensemble"]),
      evidence: z.array(evidenceSchema),
    }),
  ),
  bill_references: z.array(
    z.object({
      raw_reference: z.string(),
      reference: z.string(),
      bill_id: z.string().uuid().nullable(),
      candidate_bill_ids: z.array(z.string().uuid()),
      resolution_status: z.enum(BILL_RESOLUTIONS),
      confidence: z.number().min(0).max(1),
      notes: z.string(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  positions: z.array(
    z.object({
      target_type: z.enum(["issue", "bill"]),
      issue_id: z.string().nullable(),
      bill_reference: z.string().nullable(),
      position: z.enum(POSITIONS),
      confidence: z.number().min(0).max(1),
      source: z.enum(["rule", "ai", "ensemble"]),
      evidence: z.array(evidenceSchema),
      notes: z.string().optional(),
      requested_action: z.enum(BILL_REQUESTS).nullable(),
    }),
  ),
  requested_actions: z.array(z.enum(REQUESTED_ACTIONS)).min(1),
  sensitive: z.object({ flagged: z.boolean(), categories: z.array(z.string()) }),
  case_suggestion: z.object({ suggested: z.boolean(), category: z.string().nullable(), agency: z.string().nullable(), reason: z.string() }).nullable(),
  commitments: z.array(z.object({ text: z.string(), due_hint: z.string().nullable(), evidence: evidenceSchema })),
  asks: z.array(z.object({
    kind: z.enum(ASK_KINDS), summary: z.string().min(1).max(300), urgency: z.enum(ASK_URGENCY), due_at: z.string().nullable(),
    source: z.enum(["rule", "ai"]), evidence: evidenceSchema,
  })),
  urgency: z.object({ level: z.enum(ASK_URGENCY), reason: z.string().nullable(), due_at: z.string().nullable() }),
  ai_status: z.enum(["not_used", "ok", "failed"]),
  requires_staff_review: z.boolean(),
  review_reasons: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type ClassificationResult = z.infer<typeof classificationSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type MessageTypeKey = (typeof MESSAGE_TYPES)[number];
export type PositionKey = (typeof POSITIONS)[number];
export type RequestedActionKey = (typeof REQUESTED_ACTIONS)[number];

export function verifyEvidence(spans: Evidence[], substantive: string, subject: string): Evidence[] {
  return spans.filter((e) => {
    const source = e.field === "subject" ? subject : substantive;
    return e.end > e.start && e.end <= source.length && source.slice(e.start, e.end) === e.text;
  });
}
