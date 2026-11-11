import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./columns";
import { contacts } from "./contacts";
import { organizations, users } from "./identity";

type CommunicationKind =
  | "reply"
  | "legislative_update"
  | "newsletter"
  | "public_statement"
  | "social_post"
  | "meeting_brief"
  | "case_update"
  | "bill_status";

type Citation = { type: "message" | "bill" | "bill_version" | "case" | "url"; id: string; label: string; url?: string };

export const communicationDrafts = pgTable(
  "communication_drafts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<CommunicationKind>().notNull(),
    title: text().notNull(),
    bodyText: text().notNull().default(""),
    status: text().$type<"draft" | "in_review" | "approved" | "sent" | "exported" | "archived">().notNull().default("draft"),
    currentVersion: integer().notNull().default(1),
    isOfficial: boolean().notNull().default(true),
    citations: jsonb().$type<Citation[]>().notNull().default([]),
    relatedBillId: uuid(),
    relatedMessageId: uuid(),
    relatedCaseId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("communication_drafts_org_idx").on(t.organizationId, t.status)],
);

export const communicationDraftVersions = pgTable(
  "communication_draft_versions",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    draftId: uuid()
      .notNull()
      .references(() => communicationDrafts.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    title: text().notNull(),
    bodyText: text().notNull(),
    aiGenerated: boolean().notNull().default(false),
    authorId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("communication_draft_versions_uq").on(t.draftId, t.version)],
);

export const communicationApprovals = pgTable("communication_approvals", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  draftId: uuid()
    .notNull()
    .references(() => communicationDrafts.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  approverId: uuid()
    .notNull()
    .references(() => users.id),
  decision: text().$type<"approved" | "changes_requested">().notNull(),
  comment: text(),
  createdAt: createdAt(),
});

export const communicationBatches = pgTable("communication_batches", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  draftId: uuid()
    .notNull()
    .references(() => communicationDrafts.id, { onDelete: "cascade" }),
  name: text().notNull(),
  audience: jsonb().$type<{ type: "bill_correspondents" | "issue_correspondents" | "case_contacts" | "manual"; key?: string; contactIds?: string[] }>()
    .notNull(),
  status: text().$type<"prepared" | "approved" | "sending" | "sent" | "cancelled">().notNull().default("prepared"),
  recipientCount: integer().notNull().default(0),
  suppressedCount: integer().notNull().default(0),
  preparedBy: uuid().references(() => users.id),
  approvedBy: uuid().references(() => users.id),
  approvedAt: ts(),
  sentBy: uuid().references(() => users.id),
  sentAt: ts(),
  createdAt: createdAt(),
});

export const communicationBatchRecipients = pgTable(
  "communication_batch_recipients",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    batchId: uuid()
      .notNull()
      .references(() => communicationBatches.id, { onDelete: "cascade" }),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    email: text().notNull(),
    status: text().$type<"pending" | "sent" | "suppressed" | "failed">().notNull().default("pending"),
    suppressionReason: text(),
  },
  (t) => [uniqueIndex("communication_batch_recipients_uq").on(t.batchId, t.email)],
);

export const communicationDeliveryLogs = pgTable(
  "communication_delivery_logs",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    batchId: uuid(),
    draftId: uuid(),
    emailDraftId: uuid(),
    recipient: text().notNull(),
    channel: text().$type<"email">().notNull().default("email"),
    status: text().$type<"sent" | "failed" | "suppressed">().notNull(),
    providerMessageId: text(),
    error: text(),
    actorId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("communication_delivery_logs_org_idx").on(t.organizationId, t.createdAt)],
);
