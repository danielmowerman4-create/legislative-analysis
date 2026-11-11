import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./columns";

export const organizations = pgTable("organizations", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  legislatorName: text(),
  chamber: text().$type<"upper" | "lower" | "other">().notNull().default("lower"),
  district: text(),
  jurisdictionCode: text().notNull(),
  internalDomains: text().array().notNull().default(sql`'{}'::text[]`),
  isDemo: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text(),
    mustChangePassword: boolean().notNull().default(false),
    mfaSecretEnc: text(),
    mfaEnabledAt: ts(),
    isPlatformAdmin: boolean().notNull().default(false),
    themePreference: text().$type<"system" | "light" | "dark">().notNull().default("system"),
    lastLoginAt: ts(),
    disabledAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text().notNull().unique(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    activeOrgId: uuid().references(() => organizations.id, { onDelete: "set null" }),
    mfaVerified: boolean().notNull().default(false),
    ipHash: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastSeenAt: createdAt(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const permissions = pgTable("permissions", {
  key: text().primaryKey(),
  description: text().notNull(),
});

export const roles = pgTable(
  "roles",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    key: text().notNull(),
    name: text().notNull(),
    isSystem: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("roles_org_key_uq").on(t.organizationId, t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid().notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text().notNull().references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid().notNull().references(() => roles.id),
    title: text(),
    status: text().$type<"active" | "disabled">().notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_user_uq").on(t.organizationId, t.userId), index("memberships_user_idx").on(t.userId)],
);

export const invitations = pgTable("invitations", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  email: text().notNull(),
  roleId: uuid().notNull().references(() => roles.id),
  tokenHash: text().notNull().unique(),
  invitedBy: uuid().references(() => users.id),
  expiresAt: ts().notNull(),
  acceptedAt: ts(),
  createdAt: createdAt(),
});

export type AutoAcceptThresholds = {
  issue: number;
  position: number;
  billMatch: number;
  messageType: number;
};

export const officeSettings = pgTable("office_settings", {
  organizationId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  aiEnabled: boolean().notNull().default(true),
  aiConsentAt: ts().defaultNow(),
  aiConsentBy: uuid().references(() => users.id),
  thresholds: jsonb()
    .$type<AutoAcceptThresholds>()
    .notNull()
    .default({ issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 }),
  requireMfa: boolean().notNull().default(false),
  sendEnabled: boolean().notNull().default(false),
  saveDraftsToProvider: boolean().notNull().default(false),
  retentionDays: real(),
  preservationHold: boolean().notNull().default(false),
  emergingMinCount: real().notNull().default(5),
  // Set by a platform operator only, never from the web app.
  centerEnabled: boolean().notNull().default(true),
  centerEnabledAt: ts(),
  aiDailyLimit: integer().notNull().default(500),
  addressLookupEnabled: boolean().notNull().default(true),
  templateOverlap: real().notNull().default(0.7),
  templateMinWords: integer().notNull().default(25),
  // Appended after the fixed AI rules and cannot override them.
  aiGuidance: text(),
  replySignature: text(),
  updatedAt: updatedAt(),
});
