import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts } from "./columns";
import { organizations, users } from "./identity";

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    title: text().notNull(),
    body: text(),
    link: text(),
    sourceType: text(),
    sourceId: text(),
    dedupeKey: text().notNull(),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notifications_dedupe_uq").on(t.organizationId, t.dedupeKey), index("notifications_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const savedViews = pgTable("saved_views", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  page: text().notNull(),
  name: text().notNull(),
  filters: jsonb().$type<Record<string, string>>().notNull(),
  isShared: integer().notNull().default(0),
  createdAt: createdAt(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    summary: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)],
);

// Global: security events from before a tenant is known.
export const securityEvents = pgTable("security_events", {
  id: id(),
  userId: uuid(),
  email: text(),
  event: text().notNull(),
  ipHash: text(),
  createdAt: createdAt(),
});

// Global job ledger, written by both queue drivers.
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: id(),
    queue: text().notNull(),
    name: text().notNull(),
    organizationId: uuid(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text(),
    status: text().$type<"queued" | "running" | "succeeded" | "failed" | "dead">().notNull().default("queued"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    runAt: ts().notNull().defaultNow(),
    lockedAt: ts(),
    lockedBy: text(),
    lastError: text(),
    result: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [
    uniqueIndex("background_jobs_idem_uq").on(t.idempotencyKey),
    index("background_jobs_ready_idx").on(t.queue, t.status, t.runAt),
    index("background_jobs_org_idx").on(t.organizationId, t.createdAt),
  ],
);

export const integrationErrors = pgTable(
  "integration_errors",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid(),
    provider: text().notNull(),
    operation: text().notNull(),
    errorCode: text().notNull(),
    // Never contains message content or tokens.
    message: text().notNull(),
    occurrences: integer().notNull().default(1),
    firstSeenAt: createdAt(),
    lastSeenAt: createdAt(),
    resolvedAt: ts(),
  },
  (t) => [index("integration_errors_org_idx").on(t.organizationId, t.lastSeenAt)],
);

export const systemHealthEvents = pgTable("system_health_events", {
  id: id(),
  component: text().notNull(),
  status: text().$type<"ok" | "degraded" | "down">().notNull(),
  detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

// Global: short-lived OAuth state for mailbox connections.
export const oauthStates = pgTable("oauth_states", {
  state: text().primaryKey(),
  organizationId: uuid().notNull(),
  userId: uuid().notNull(),
  provider: text().notNull(),
  codeVerifierEnc: text().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: ts().notNull(),
  usedAt: ts(),
});

export const rateLimits = pgTable("rate_limits", {
  key: text().primaryKey(),
  count: integer().notNull(),
  windowStart: ts().notNull(),
});

export const assistantQueries = pgTable(
  "assistant_queries",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    question: text().notNull(),
    intent: text().notNull(),
    answer: text().notNull(),
    sources: jsonb().$type<{ type: string; id: string; label: string; href: string }[]>().notNull().default([]),
    mode: text().$type<"deterministic" | "ai">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_queries_org_user_idx").on(t.organizationId, t.userId, t.createdAt)],
);
