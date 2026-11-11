import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, tsvector, type EvidenceSpan } from "./columns";
import { emailMessages } from "./email";
import { contacts } from "./contacts";
import { organizations, users } from "./identity";

export type CaseStatus = "new" | "under_review" | "awaiting_constituent" | "awaiting_agency" | "resolved" | "closed";
export type CasePriority = "low" | "normal" | "high" | "urgent";

export const agencyDirectory = pgTable(
  "agency_directory",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    abbreviation: text(),
    domains: text().array().notNull().default(sql`'{}'::text[]`),
    contactEmail: text(),
    phone: text(),
    referralTemplate: text(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agency_directory_org_name_uq").on(t.organizationId, t.name)],
);

export const caseCounters = pgTable(
  "case_counters",
  {
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    year: integer().notNull(),
    lastNumber: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.year] })],
);

export const cases = pgTable(
  "cases",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    caseNumber: text().notNull(),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    title: text().notNull(),
    category: text().notNull(),
    description: text().notNull().default(""),
    status: text().$type<CaseStatus>().notNull().default("new"),
    priority: text().$type<CasePriority>().notNull().default("normal"),
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => users.id),
    agencyId: uuid().references(() => agencyDirectory.id, { onDelete: "set null" }),
    isSensitive: boolean().notNull().default(false),
    consentStatus: text().$type<"not_required" | "required" | "received" | "declined">().notNull().default("not_required"),
    consentReceivedAt: ts(),
    followUpAt: ts(),
    lastActivityAt: ts().notNull().defaultNow(),
    referredAt: ts(),
    agencyRespondedAt: ts(),
    resolvedAt: ts(),
    closedAt: ts(),
    resolutionNotes: text(),
    sourceMessageId: uuid().references(() => emailMessages.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    searchTsv: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(case_number, '') || ' ' || coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),
  },
  (t) => [
    uniqueIndex("cases_org_number_uq").on(t.organizationId, t.caseNumber),
    index("cases_org_status_idx").on(t.organizationId, t.status),
    index("cases_assigned_idx").on(t.assignedTo),
    index("cases_tsv_idx").using("gin", t.searchTsv),
  ],
);

export const caseEvents = pgTable(
  "case_events",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid()
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id),
    type: text()
      .$type<
        | "created"
        | "status_changed"
        | "assigned"
        | "note"
        | "email_linked"
        | "referred_to_agency"
        | "agency_responded"
        | "attachment_added"
        | "follow_up_set"
        | "consent_recorded"
        | "priority_changed"
      >()
      .notNull(),
    visibility: text().$type<"office" | "private">().notNull().default("office"),
    body: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("case_events_case_idx").on(t.caseId, t.createdAt)],
);

export const caseAssignments = pgTable("case_assignments", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  caseId: uuid()
    .notNull()
    .references(() => cases.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .references(() => users.id),
  assignedBy: uuid().references(() => users.id),
  assignedAt: createdAt(),
  unassignedAt: ts(),
});

export const caseMessages = pgTable(
  "case_messages",
  {
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid()
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    messageId: uuid()
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    linkedBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.messageId] })],
);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    status: text().$type<"suggested" | "open" | "done" | "dismissed">().notNull().default("open"),
    source: text().$type<"staff" | "ai_suggested">().notNull().default("staff"),
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => users.id),
    dueAt: ts(),
    remindAt: ts(),
    completedAt: ts(),
    caseId: uuid().references(() => cases.id, { onDelete: "set null" }),
    messageId: uuid().references(() => emailMessages.id, { onDelete: "set null" }),
    evidence: jsonb().$type<EvidenceSpan[]>().notNull().default([]),
    confirmedBy: uuid().references(() => users.id),
    confirmedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_org_status_idx").on(t.organizationId, t.status, t.dueAt), index("tasks_assigned_idx").on(t.assignedTo)],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);
