import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./columns";
import { emailConnections, emailMessages } from "./email";
import { organizations, users } from "./identity";

export type LedgerDisposition = "pending" | "filed" | "held" | "hidden" | "screened" | "duplicate" | "failed";

export const mailLedger = pgTable(
  "mail_ledger",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
    sourceKey: text().notNull(),
    providerMessageId: text(),
    fromAddress: text(),
    subject: text(),
    receivedAt: ts(),
    disposition: text().$type<LedgerDisposition>().notNull().default("pending"),
    reason: text(),
    messageId: uuid().references(() => emailMessages.id, { onDelete: "set null" }),
    ruleId: uuid(),
    attempts: integer().notNull().default(1),
    lastError: text(),
    restoredBy: uuid().references(() => users.id),
    restoredAt: ts(),
    settledAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("mail_ledger_source_uq").on(t.organizationId, t.sourceKey),
    index("mail_ledger_org_disposition_idx").on(t.organizationId, t.disposition),
    index("mail_ledger_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export const mailReconciliations = pgTable(
  "mail_reconciliations",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid().references(() => emailConnections.id, { onDelete: "set null" }),
    windowStart: ts().notNull(),
    windowEnd: ts().notNull(),
    mailboxCount: integer().notNull(),
    ledgerCount: integer().notNull(),
    repaired: integer().notNull().default(0),
    stillMissing: integer().notNull().default(0),
    status: text().$type<"matched" | "repaired" | "gap">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("mail_reconciliations_org_idx").on(t.organizationId, t.createdAt)],
);

export type SenderRuleKind = "hide" | "relay";

// Only staff can make a rule active; the system may only propose one.
export const senderRules = pgTable(
  "sender_rules",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<SenderRuleKind>().notNull(),
    matchType: text().$type<"address" | "domain">().notNull(),
    value: text().notNull(),
    status: text().$type<"proposed" | "active" | "retired">().notNull().default("proposed"),
    reason: text(),
    proposedBy: text().$type<"system" | "staff">().notNull().default("staff"),
    createdBy: uuid().references(() => users.id),
    confirmedBy: uuid().references(() => users.id),
    confirmedAt: ts(),
    hits: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("sender_rules_uq").on(t.organizationId, t.kind, t.matchType, t.value), index("sender_rules_org_status_idx").on(t.organizationId, t.status),
  ],
);

type AskKind = "casework" | "position" | "meeting" | "information" | "follow_up" | "safety" | "deadline" | "other";
type AskUrgency = "routine" | "soon" | "urgent";

export const messageAsks = pgTable(
  "message_asks",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    kind: text().$type<AskKind>().notNull(),
    summary: text().notNull(),
    quote: text().notNull(),
    quoteStart: integer().notNull(),
    quoteEnd: integer().notNull(),
    source: text().$type<"rule" | "ai" | "staff">().notNull(),
    urgency: text().$type<AskUrgency>().notNull().default("routine"),
    dueAt: ts(),
    status: text().$type<"open" | "handled" | "dismissed">().notNull().default("open"),
    caseId: uuid(),
    handledBy: uuid().references(() => users.id),
    handledAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("message_asks_org_status_idx").on(t.organizationId, t.status, t.urgency), index("message_asks_message_idx").on(t.messageId)],
);
