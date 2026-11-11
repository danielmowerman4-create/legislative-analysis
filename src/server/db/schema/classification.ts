import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, type EvidenceSpan } from "./columns";
import { emailMessages } from "./email";
import { organizations, users } from "./identity";

type LabelSource = "rule" | "ai" | "ensemble" | "staff";
type LabelStatus = "provisional" | "needs_review" | "confirmed" | "rejected";
export type Position = "support" | "oppose" | "mixed" | "neutral" | "unclear";
export type BillResolution = "resolved" | "ambiguous" | "unmatched" | "out_of_jurisdiction";
type BillRequest = "vote_yes" | "vote_no" | "amend" | "cosponsor" | "hearing" | "information";

export const issueTaxonomy = pgTable(
  "issue_taxonomy",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    key: text().notNull(),
    parentKey: text(),
    label: text().notNull(),
    description: text(),
    keywords: text().array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("issue_taxonomy_org_key_uq").on(t.organizationId, t.key)],
);

export const classificationRuns = pgTable(
  "classification_runs",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    pipelineVersion: text().notNull(),
    mode: text().$type<"rules" | "rules+ai">().notNull(),
    model: text(),
    inputHash: text().notNull(),
    output: jsonb().$type<Record<string, unknown>>().notNull(),
    warnings: jsonb().$type<string[]>().notNull().default([]),
    latencyMs: integer(),
    status: text().$type<"succeeded" | "failed">().notNull(),
    error: text(),
    triggeredBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("classification_runs_message_idx").on(t.messageId)],
);

const decision = () => ({
  confidence: real().notNull(),
  source: text().$type<LabelSource>().notNull(),
  status: text().$type<LabelStatus>().notNull(),
  evidence: jsonb().$type<EvidenceSpan[]>().notNull().default([]),
  runId: uuid().references(() => classificationRuns.id, { onDelete: "set null" }),
  decidedBy: uuid().references(() => users.id),
  decidedAt: ts(),
  createdAt: createdAt(),
});

export const messageIssueLinks = pgTable(
  "message_issue_links",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    issueKey: text().notNull(),
    ...decision(),
  },
  (t) => [uniqueIndex("message_issue_links_uq").on(t.messageId, t.issueKey), index("message_issue_links_issue_idx").on(t.organizationId, t.issueKey)],
);

export const messageBillLinks = pgTable(
  "message_bill_links",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    reference: text().notNull(),
    rawReference: text().notNull(),
    billId: uuid(),
    resolution: text().$type<BillResolution>().notNull(),
    candidateBillIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    resolutionNotes: text(),
    ...decision(),
  },
  (t) => [uniqueIndex("message_bill_links_uq").on(t.messageId, t.reference), index("message_bill_links_bill_idx").on(t.billId)],
);

export const issuePositions = pgTable(
  "issue_positions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    contactId: uuid(),
    targetKey: text().notNull(),
    targetType: text().$type<"issue" | "bill">().notNull(),
    issueKey: text(),
    billReference: text(),
    billId: uuid(),
    position: text().$type<Position>().notNull(),
    requestedAction: text().$type<BillRequest>(),
    ...decision(),
  },
  (t) => [
    uniqueIndex("issue_positions_uq").on(t.messageId, t.targetKey),
    index("issue_positions_bill_idx").on(t.billId),
    index("issue_positions_issue_idx").on(t.organizationId, t.issueKey),
  ],
);

export const classificationFeedback = pgTable(
  "classification_feedback",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    field: text().$type<"issue" | "bill" | "position" | "message_type" | "requested_action" | "summary">().notNull(),
    targetKey: text(),
    before: jsonb().$type<unknown>(),
    after: jsonb().$type<unknown>(),
    actorId: uuid().references(() => users.id),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index("classification_feedback_message_idx").on(t.messageId)],
);

export type ReviewKind =
  | "issue"
  | "bill_match"
  | "position"
  | "message_type"
  | "case_suggestion"
  | "task_suggestion"
  | "contact_match"
  | "sensitive"
  | "sender_check";

export const reviewQueue = pgTable(
  "review_queue",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<ReviewKind>().notNull(),
    messageId: uuid().references(() => emailMessages.id, { onDelete: "cascade" }),
    entityType: text().notNull(),
    entityId: text().notNull(),
    reason: text().notNull(),
    priority: integer().notNull().default(50),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().$type<"open" | "resolved" | "dismissed">().notNull().default("open"),
    resolvedBy: uuid().references(() => users.id),
    resolvedAt: ts(),
    resolution: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("review_queue_open_uq").on(t.organizationId, t.kind, t.entityId).where(sql`status = 'open'`),
    index("review_queue_org_status_idx").on(t.organizationId, t.status, t.priority),
  ],
);

export const templateClusters = pgTable(
  "template_clusters",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    fingerprint: text().notNull(),
    label: text(),
    sampleMessageId: uuid(),
    canonicalShingles: jsonb().$type<number[]>().notNull().default([]),
    sketch: integer().array().notNull().default(sql`'{}'::integer[]`),
    messageCount: integer().notNull().default(0),
    firstSeenAt: ts().notNull(),
    lastSeenAt: ts().notNull(),
  },
  (t) => [uniqueIndex("template_clusters_fp_uq").on(t.organizationId, t.fingerprint), index("template_clusters_sketch_idx").using("gin", t.sketch)],
);
