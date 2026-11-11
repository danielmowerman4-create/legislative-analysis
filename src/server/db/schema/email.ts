import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, tsvector, updatedAt } from "./columns";
import { organizations, users } from "./identity";

type MailProvider = "google" | "microsoft" | "imap";
type ConnectionStatus = "pending" | "active" | "reauth_required" | "error" | "disconnected";
export type SenderTrust = "unknown" | "verified" | "relay" | "unverified" | "failed";

export const emailConnections = pgTable(
  "email_connections",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().$type<MailProvider>().notNull(),
    emailAddress: text().notNull(),
    displayName: text(),
    status: text().$type<ConnectionStatus>().notNull().default("pending"),
    authMode: text().$type<"delegated" | "application" | "password">().notNull().default("delegated"),
    tenantId: text(),
    scopes: text().array().notNull().default(sql`'{}'::text[]`),
    accessTokenEnc: text(),
    refreshTokenEnc: text(),
    tokenExpiresAt: ts(),
    imapHost: text(),
    imapPort: integer(),
    appPasswordEnc: text(),
    authorizedBy: uuid().references(() => users.id),
    authorizationStatement: text(),
    authorizedAt: ts(),
    importFrom: date(),
    importTo: date(),
    selectedFolders: jsonb().$type<{ id: string; name: string }[]>().notNull().default([]),
    sentFolder: jsonb().$type<{ id: string; name: string } | null>(),
    sendEnabledAt: ts(),
    sendEnabledBy: uuid().references(() => users.id),
    lastSyncedAt: ts(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_connections_org_provider_addr_uq").on(t.organizationId, t.provider, t.emailAddress)],
);

export const emailSyncState = pgTable(
  "email_sync_state",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid()
      .notNull()
      .references(() => emailConnections.id, { onDelete: "cascade" }),
    folderId: text().notNull().default("*"),
    folderName: text(),
    purpose: text().$type<"mail" | "sent">().notNull().default("mail"),
    cursorType: text().$type<"gmail_history" | "graph_delta" | "imap_uid">().notNull(),
    cursor: text(),
    subscriptionId: text(),
    subscriptionExpiresAt: ts(),
    clientStateHash: text(),
    backfillStatus: text().$type<"not_started" | "listing" | "fetching" | "completed" | "failed">().notNull().default("not_started"),
    backfillPageToken: text(),
    backfillListed: integer().notNull().default(0),
    backfillFetched: integer().notNull().default(0),
    backfillFailed: integer().notNull().default(0),
    lastIncrementalAt: ts(),
    lastReconciledAt: ts(),
    lastSuccessAt: ts(),
    lastCursorResetAt: ts(),
    consecutiveFailures: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("email_sync_state_conn_folder_uq").on(t.connectionId, t.folderId),
    index("email_sync_state_subscription_idx").on(t.subscriptionId),
  ],
);

export const emailThreads = pgTable(
  "email_threads",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
    providerThreadId: text(),
    subjectNormalized: text().notNull().default(""),
    firstMessageAt: ts(),
    lastMessageAt: ts(),
    messageCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_threads_provider_uq").on(t.connectionId, t.providerThreadId),
    index("email_threads_org_last_idx").on(t.organizationId, t.lastMessageAt),
  ],
);

export type MessageType =
  | "constituent_policy"
  | "constituent_service"
  | "meeting_request"
  | "constituent_general"
  | "government_agency"
  | "legislative_staff"
  | "organization"
  | "newsletter_automated"
  | "media"
  | "vendor"
  | "advocacy_lobbyist"
  | "spam"
  | "other";

type RequestedAction =
  | "policy_response"
  | "agency_assistance"
  | "meeting"
  | "legislation_info"
  | "follow_up"
  | "referral"
  | "none";

export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
    providerMessageId: text(),
    rfcMessageId: text(),
    inReplyTo: text(),
    references: text().array().notNull().default(sql`'{}'::text[]`),
    threadId: uuid().references(() => emailThreads.id, { onDelete: "set null" }),
    direction: text().$type<"inbound" | "outbound">().notNull(),
    labels: text().array().notNull().default(sql`'{}'::text[]`),
    subject: text().notNull().default(""),
    fromAddress: text().notNull(),
    fromName: text(),
    sentAt: ts().notNull(),
    receivedAt: ts().notNull(),
    snippet: text().notNull().default(""),
    bodyText: text().notNull().default(""),
    bodyHtmlSanitized: text(),
    substantiveText: text().notNull().default(""),
    quotedText: text(),
    forwardedText: text(),
    language: text(),
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    rawSizeBytes: integer(),
    hasAttachments: boolean().notNull().default(false),
    isRead: boolean().notNull().default(false),
    processingStatus: text().$type<"pending" | "processed" | "failed">().notNull().default("pending"),
    triageStatus: text().$type<"new" | "in_progress" | "done" | "archived">().notNull().default("new"),
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    contactId: uuid(),
    messageTypes: text().array().$type<MessageType[]>().notNull().default(sql`'{}'::text[]`),
    messageTypeConfidence: jsonb().$type<Partial<Record<MessageType, number>>>().notNull().default({}),
    requestedActions: text().array().$type<RequestedAction[]>().notNull().default(sql`'{}'::text[]`),
    summary: text(),
    summarySource: text().$type<"rule" | "ai" | "staff">(),
    priority: text().$type<"low" | "normal" | "high" | "urgent">().notNull().default("normal"),
    isSensitive: boolean().notNull().default(false),
    isAutomated: boolean().notNull().default(false),
    isSpam: boolean().notNull().default(false),
    isInternal: boolean().notNull().default(false),
    includeOverride: boolean().notNull().default(false),
    templateClusterId: uuid(),
    duplicateOfId: uuid(),
    requiresReview: boolean().notNull().default(false),
    senderTrust: text().$type<SenderTrust>().notNull().default("unknown"),
    senderTrustDetail: jsonb().$type<{ spf: string | null; dkim: string | null; dmarc: string | null; reasons: string[] }>().notNull()
      .default({ spf: null, dkim: null, dmarc: null, reasons: [] }),
    // Who a relay platform says it writes for. Never trusted on its own.
    claimedAddress: text(),
    claimedName: text(),
    personalNote: text(),
    urgencyReason: text(),
    dueAt: ts(),
    searchTsv: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(subject, '')), 'A') || setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || coalesce(from_address, '')), 'B') || setweight(to_tsvector('english', coalesce(substantive_text, '')), 'C')`,
    ),
    embedding: vector({ dimensions: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_messages_provider_uq").on(t.connectionId, t.providerMessageId),
    uniqueIndex("email_messages_rfc_uq").on(t.organizationId, t.rfcMessageId, t.direction).where(sql`rfc_message_id is not null`),
    index("email_messages_org_received_idx").on(t.organizationId, t.receivedAt),
    index("email_messages_contact_idx").on(t.contactId),
    index("email_messages_thread_idx").on(t.threadId),
    index("email_messages_template_cluster_idx").on(t.templateClusterId),
    index("email_messages_tsv_idx").using("gin", t.searchTsv),
  ],
);

export const emailParticipants = pgTable(
  "email_participants",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    role: text().$type<"from" | "to" | "cc" | "bcc" | "reply_to">().notNull(),
    address: text().notNull(),
    name: text(),
    contactId: uuid(),
  },
  (t) => [index("email_participants_message_idx").on(t.messageId), index("email_participants_address_idx").on(t.organizationId, t.address)],
);

export const emailAttachments = pgTable(
  "email_attachments",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    filename: text().notNull(),
    declaredType: text(),
    sniffedType: text(),
    sizeBytes: integer().notNull(),
    sha256: text(),
    storageKey: text(),
    status: text().$type<"stored" | "blocked" | "skipped">().notNull(),
    blockReason: text(),
    isInline: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("email_attachments_message_idx").on(t.messageId)],
);

export const emailDrafts = pgTable("email_drafts", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  replyToMessageId: uuid().references(() => emailMessages.id, { onDelete: "set null" }),
  connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
  authorId: uuid().references(() => users.id),
  toAddresses: text().array().notNull().default(sql`'{}'::text[]`),
  subject: text().notNull().default(""),
  bodyText: text().notNull().default(""),
  status: text().$type<"draft" | "approved" | "sending" | "saved_to_provider" | "sent" | "discarded">().notNull().default("draft"),
  providerDraftId: text(),
  aiGenerated: boolean().notNull().default(false),
  citations: jsonb().$type<{ type: string; id: string; label: string }[]>().notNull().default([]),
  approvedBy: uuid().references(() => users.id),
  approvedAt: ts(),
  sentBy: uuid().references(() => users.id),
  sentAt: ts(),
  sentVia: text().$type<"app" | "mailbox" | "marked">(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const replyDeliveries = pgTable(
  "reply_deliveries",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    draftId: uuid()
      .notNull()
      .references(() => emailDrafts.id, { onDelete: "cascade" }),
    messageId: uuid().references(() => emailMessages.id, { onDelete: "set null" }),
    connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
    toAddress: text().notNull(),
    toName: text(),
    // A copy left in "sending" is never sent again by itself.
    status: text().$type<"queued" | "sending" | "sent" | "failed">().notNull().default("queued"),
    rfcMessageId: text().notNull(),
    providerMessageId: text(),
    error: text(),
    attempts: integer().notNull().default(0),
    sentAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reply_deliveries_draft_to_uq").on(t.draftId, t.toAddress), index("reply_deliveries_rfc_idx").on(t.organizationId, t.rfcMessageId)],
);

export const messageNotes = pgTable(
  "message_notes",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => users.id),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("message_notes_message_idx").on(t.messageId)],
);

export const messageEvents = pgTable(
  "message_events",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("message_events_message_idx").on(t.messageId)],
);

// Global (pre-tenant): every webhook delivery, for idempotency and audit.
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  provider: text().$type<MailProvider>().notNull(),
  deliveryKey: text().notNull().unique(),
  connectionId: uuid(),
  status: text().$type<"enqueued" | "duplicate" | "rejected" | "ignored">().notNull(),
  reason: text(),
  receivedAt: createdAt(),
});
