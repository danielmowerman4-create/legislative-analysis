import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, tsvector, updatedAt } from "./columns";
import { organizations, users } from "./identity";

export type ContactKind = "person" | "organization" | "agency" | "staff" | "unknown" | "list" | "vendor" | "media";
export type DistrictStatus = "in_district" | "outside" | "out_of_state";
type AddressLookupStatus = "pending" | "matched" | "not_found" | "out_of_state" | "skipped";

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<ContactKind>().notNull().default("person"),
    fullName: text(),
    firstName: text(),
    lastName: text(),
    organizationName: text(),
    phones: jsonb().$type<{ number: string; label?: string; source: string }[]>().notNull().default([]),
    municipality: text(),
    county: text(),
    // Only from a verified source (lookup or staff). Never inferred.
    district: text(),
    districtSource: text(),
    districtVerifiedAt: ts(),
    districtStatus: text().$type<DistrictStatus>(),
    preferredContactMethod: text().$type<"email" | "phone" | "mail">(),
    mergedIntoId: uuid(),
    firstSeenAt: ts(),
    lastContactAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    searchTsv: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(full_name, '') || ' ' || coalesce(organization_name, '') || ' ' || coalesce(municipality, ''))`,
    ),
  },
  (t) => [index("contacts_org_idx").on(t.organizationId, t.lastContactAt), index("contacts_tsv_idx").using("gin", t.searchTsv)],
);

export const contactEmails = pgTable(
  "contact_emails",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    email: text().notNull(),
    isPrimary: boolean().notNull().default(false),
    verified: boolean().notNull().default(false),
    verifiedSource: text().$type<"inbound_message" | "staff" | "import" | "relay">(),
    isShared: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_emails_org_email_uq").on(t.organizationId, t.email), index("contact_emails_contact_idx").on(t.contactId)],
);

export const contactAddresses = pgTable(
  "contact_addresses",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    line1: text(),
    line2: text(),
    city: text(),
    state: text(),
    postalCode: text(),
    source: text().notNull(),
    verifiedAt: ts(),
    normalized: text(),
    messageId: uuid(),
    lookupStatus: text().$type<AddressLookupStatus>().notNull().default("pending"),
    lookedUpAt: ts(),
    district: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contact_addresses_norm_uq").on(t.contactId, t.normalized)],
);

export const contactMergeHistory = pgTable("contact_merge_history", {
  id: id(),
  organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
  survivorId: uuid().notNull(),
  mergedId: uuid().notNull(),
  mergedBy: uuid().references(() => users.id),
  reason: text(),
  snapshot: jsonb().$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  undoneAt: ts(),
});

export const contactNotes = pgTable(
  "contact_notes",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => users.id),
    body: text().notNull(),
    visibility: text().$type<"office" | "private">().notNull().default("office"),
    createdAt: createdAt(),
  },
  (t) => [index("contact_notes_contact_idx").on(t.contactId)],
);

export const contactCommunicationPreferences = pgTable(
  "contact_communication_preferences",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text().$type<"email" | "phone" | "mail">().notNull(),
    topic: text(),
    status: text().$type<"opted_in" | "opted_out" | "suppressed">().notNull(),
    reason: text(),
    source: text().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("contact_prefs_uq").on(t.contactId, t.channel, sql`coalesce(${t.topic}, '')`)],
);
