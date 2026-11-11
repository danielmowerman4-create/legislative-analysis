import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
import type { StoredAnalysis, StoredFiscalNote } from "../../legislation/types";
import { createdAt, id, orgId, ts, tsvector } from "./columns";
import { organizations, users } from "./identity";

// Public legislative data is global; tracking and notes are tenant-owned.

export type CommitteeRole = { committee: string; code: string | null; role: "Member" | "Chair" | "Vice Chair" | "Ranking Member" };
export type MemberContact = { email?: string; phone?: string; office?: string };
export type LegislativeProviderKey = "legiscan" | "openstates" | "fixture" | "ctga";
export type BillStatus =
  | "introduced"
  | "in_committee"
  | "passed_chamber"
  | "passed_both"
  | "sent_to_executive"
  | "enacted"
  | "vetoed"
  | "failed"
  | "withdrawn"
  | "other";
export type ActionClass =
  | "introduced"
  | "referred"
  | "committee_action"
  | "hearing_scheduled"
  | "amendment"
  | "chamber_vote"
  | "passed"
  | "failed"
  | "signed"
  | "vetoed"
  | "other";

export const jurisdictions = pgTable("jurisdictions", {
  code: text().primaryKey(),
  name: text().notNull(),
  classification: text().$type<"state" | "demo">().notNull().default("state"),
  timezone: text().notNull().default("America/New_York"),
  providerIds: jsonb().$type<Partial<Record<LegislativeProviderKey, string>>>().notNull().default({}),
});

export const legislativeSessions = pgTable(
  "legislative_sessions",
  {
    id: id(),
    jurisdictionCode: text()
      .notNull()
      .references(() => jurisdictions.code),
    identifier: text().notNull(),
    name: text().notNull(),
    startDate: date(),
    endDate: date(),
    isSpecial: boolean().notNull().default(false),
    providerIds: jsonb().$type<Partial<Record<LegislativeProviderKey, string>>>().notNull().default({}),
  },
  (t) => [uniqueIndex("legislative_sessions_uq").on(t.jurisdictionCode, t.identifier)],
);

export const bills = pgTable(
  "bills",
  {
    id: id(),
    jurisdictionCode: text()
      .notNull()
      .references(() => jurisdictions.code),
    sessionId: uuid()
      .notNull()
      .references(() => legislativeSessions.id),
    identifier: text().notNull(),
    billType: text().notNull(),
    number: integer().notNull(),
    chamber: text().$type<"upper" | "lower" | "joint">().notNull(),
    title: text().notNull(),
    officialSummary: text(),
    analysis: jsonb().$type<StoredAnalysis | null>(),
    fiscal: jsonb().$type<StoredFiscalNote | null>(),
    plainSummary: text(),
    plainSummaryModel: text(),
    plainSummaryAt: ts(),
    status: text().$type<BillStatus>().notNull().default("introduced"),
    statusText: text(),
    statusDate: date(),
    introducedAt: date(),
    lastActionAt: date(),
    lastActionText: text(),
    effectiveDate: date(),
    subjects: text().array().notNull().default(sql`'{}'::text[]`),
    codeSections: text().array().notNull().default(sql`'{}'::text[]`),
    sourceUrls: jsonb().$type<{ label: string; url: string }[]>().notNull().default([]),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    providerBillId: text().notNull(),
    providerChangeHash: text(),
    sourceUpdatedAt: ts(),
    lastSyncedAt: ts(),
    searchTsv: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('simple', coalesce(identifier, '')), 'A') || setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(official_summary, '')), 'B')`,
    ),
    embedding: vector({ dimensions: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bills_session_identifier_uq").on(t.jurisdictionCode, t.sessionId, t.identifier),
    uniqueIndex("bills_provider_uq").on(t.provider, t.providerBillId),
    index("bills_identifier_idx").on(t.identifier),
    index("bills_tsv_idx").using("gin", t.searchTsv),
    index("bills_last_action_idx").on(t.lastActionAt),
    index("bills_code_sections_idx").using("gin", t.codeSections),
    index("bills_subjects_idx").using("gin", t.subjects),
  ],
);

export type BillRelationKind = "same_as" | "similar_to" | "replaces" | "replaced_by" | "cross_filed" | "enabling" | "enabled_by" | "related" | "carry_over";

export const billRelations = pgTable(
  "bill_relations",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    relatedProviderBillId: text().notNull(),
    relatedIdentifier: text().notNull(),
    kind: text().$type<BillRelationKind>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bill_relations_uq").on(t.billId, t.relatedProviderBillId, t.kind)],
);

export const billVersions = pgTable(
  "bill_versions",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    providerVersionId: text().notNull(),
    label: text().notNull(),
    versionDate: date(),
    url: text(),
    mimeType: text(),
    textContent: text(),
    textSha256: text(),
    fetchedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bill_versions_uq").on(t.billId, t.providerVersionId)],
);

export const billActions = pgTable(
  "bill_actions",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    providerKey: text().notNull(),
    actionDate: date().notNull(),
    chamber: text(),
    description: text().notNull(),
    classification: text().array().$type<ActionClass[]>().notNull().default(sql`'{}'::text[]`),
    sequence: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bill_actions_uq").on(t.billId, t.providerKey), index("bill_actions_bill_date_idx").on(t.billId, t.actionDate)],
);

export const billStatusHistory = pgTable(
  "bill_status_history",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    fromStatus: text(),
    toStatus: text().notNull(),
    fromTitle: text(),
    toTitle: text(),
    sourceDate: date(),
    syncId: uuid(),
    observedAt: createdAt(),
  },
  (t) => [index("bill_status_history_bill_idx").on(t.billId)],
);

export const legislators = pgTable(
  "legislators",
  {
    id: id(),
    jurisdictionCode: text()
      .notNull()
      .references(() => jurisdictions.code),
    name: text().notNull(),
    party: text(),
    chamber: text(),
    district: text(),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    providerPersonId: text().notNull(),
    active: boolean().notNull().default(true),
    committeeRoles: jsonb().$type<CommitteeRole[]>().notNull().default([]),
    contact: jsonb().$type<MemberContact>().notNull().default({}),
    title: text(),
  },
  (t) => [uniqueIndex("legislators_provider_uq").on(t.provider, t.providerPersonId)],
);

export const billSponsors = pgTable(
  "bill_sponsors",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    legislatorId: uuid().references(() => legislators.id),
    name: text().notNull(),
    sponsorType: text().$type<"primary" | "cosponsor">().notNull(),
    sequence: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("bill_sponsors_uq").on(t.billId, t.name, t.sponsorType)],
);

export const committees = pgTable(
  "committees",
  {
    id: id(),
    jurisdictionCode: text()
      .notNull()
      .references(() => jurisdictions.code),
    name: text().notNull(),
    chamber: text(),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    providerCommitteeId: text().notNull(),
  },
  (t) => [uniqueIndex("committees_provider_uq").on(t.provider, t.providerCommitteeId)],
);

export const billCommitteeLinks = pgTable(
  "bill_committee_links",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    committeeId: uuid()
      .notNull()
      .references(() => committees.id),
    referredAt: date(),
    status: text(),
  },
  (t) => [uniqueIndex("bill_committee_links_uq").on(t.billId, t.committeeId)],
);

export const amendments = pgTable(
  "amendments",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    providerAmendmentId: text().notNull(),
    title: text().notNull(),
    description: text(),
    chamber: text(),
    adopted: boolean(),
    amendmentDate: date(),
    url: text(),
    textContent: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("amendments_uq").on(t.billId, t.providerAmendmentId)],
);

export const rollCalls = pgTable(
  "roll_calls",
  {
    id: id(),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    providerRollCallId: text().notNull(),
    voteDate: date(),
    chamber: text(),
    motion: text().notNull(),
    yes: integer().notNull().default(0),
    no: integer().notNull().default(0),
    other: integer().notNull().default(0),
    passed: boolean(),
    url: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("roll_calls_uq").on(t.billId, t.providerRollCallId)],
);

export const rollCallVotes = pgTable(
  "roll_call_votes",
  {
    id: id(),
    rollCallId: uuid()
      .notNull()
      .references(() => rollCalls.id, { onDelete: "cascade" }),
    legislatorId: uuid().references(() => legislators.id),
    voterName: text().notNull(),
    vote: text().$type<"yes" | "no" | "not_voting" | "absent" | "excused" | "other">().notNull(),
  },
  (t) => [uniqueIndex("roll_call_votes_uq").on(t.rollCallId, t.voterName)],
);

export const legislativeEvents = pgTable(
  "legislative_events",
  {
    id: id(),
    jurisdictionCode: text()
      .notNull()
      .references(() => jurisdictions.code),
    kind: text().$type<"hearing" | "floor" | "other">().notNull(),
    title: text().notNull(),
    startsAt: ts().notNull(),
    location: text(),
    committeeId: uuid().references(() => committees.id),
    billIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    status: text().$type<"scheduled" | "cancelled" | "held">().notNull().default("scheduled"),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    providerEventId: text().notNull(),
    sourceUrl: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("legislative_events_uq").on(t.provider, t.providerEventId), index("legislative_events_starts_idx").on(t.startsAt)],
);

export const sourceDocuments = pgTable("source_documents", {
  url: text().primaryKey(),
  found: boolean().notNull(),
  body: text(),
  checkedAt: createdAt(),
});

export const legislativeSourceSyncs = pgTable(
  "legislative_source_syncs",
  {
    id: id(),
    provider: text().$type<LegislativeProviderKey>().notNull(),
    jurisdictionCode: text().notNull(),
    sessionId: uuid(),
    status: text().$type<"running" | "succeeded" | "partial" | "failed">().notNull(),
    billsSeen: integer().notNull().default(0),
    billsChanged: integer().notNull().default(0),
    actionsAdded: integer().notNull().default(0),
    versionsAdded: integer().notNull().default(0),
    error: text(),
    startedAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [index("legislative_source_syncs_idx").on(t.provider, t.jurisdictionCode, t.startedAt)],
);

// Tenant-owned

export const trackedBills = pgTable(
  "tracked_bills",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    trackedBy: uuid().references(() => users.id),
    reason: text(),
    position: text().$type<BillPosition>().notNull().default("watching"),
    priority: text().$type<BillPriority>().notNull().default("normal"),
    assignedTo: uuid().references(() => users.id, { onDelete: "set null" }),
    nextStep: text(),
    dueDate: date(),
    updatedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tracked_bills_uq").on(t.organizationId, t.billId)],
);

export type BillPosition = "support" | "oppose" | "neutral" | "watching";
export type BillPriority = "high" | "normal" | "low";

export type WhipStance = "yes" | "lean_yes" | "undecided" | "lean_no" | "no";

export const whipEntries = pgTable(
  "whip_entries",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    legislatorId: uuid()
      .notNull()
      .references(() => legislators.id, { onDelete: "cascade" }),
    stance: text().$type<WhipStance>().notNull(),
    note: text(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("whip_entries_uq").on(t.organizationId, t.billId, t.legislatorId)],
);

export type BillAlertKind = "keyword" | "code" | "subject" | "sponsor";

export const billAlertRules = pgTable(
  "bill_alert_rules",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<BillAlertKind>().notNull(),
    value: text().notNull(),
    active: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id),
    lastMatchedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bill_alert_rules_uq").on(t.organizationId, t.kind, t.value)],
);

export const officeBillLinks = pgTable(
  "office_bill_links",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    relatedBillId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    note: text(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("office_bill_links_uq").on(t.organizationId, t.billId, t.relatedBillId)],
);

export const follows = pgTable(
  "follows",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: text().$type<"bill" | "committee" | "topic">().notNull(),
    targetKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("follows_uq").on(t.organizationId, t.userId, t.targetType, t.targetKey)],
);

export const billNotes = pgTable(
  "bill_notes",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid()
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => users.id),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("bill_notes_bill_idx").on(t.organizationId, t.billId)],
);
