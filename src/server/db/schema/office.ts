import { boolean, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, orgId, ts, updatedAt } from "./columns";
import { organizations, users } from "./identity";
import { bills } from "./legislation";

// The office's own calendar entries, shown beside the legislature's hearings.
export const officeEvents = pgTable(
  "office_events",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    title: text().notNull(),
    startsAt: ts().notNull(),
    allDay: boolean().notNull().default(false),
    location: text(),
    note: text(),
    billId: uuid().references(() => bills.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("office_events_starts_idx").on(t.organizationId, t.startsAt)],
);

export const PRESS_KINDS = ["statement", "vote", "bill", "hearing", "event"] as const;
export type PressKind = (typeof PRESS_KINDS)[number];
export const GRAPHIC_LAYOUTS = ["wash", "split", "bands", "type"] as const;
export const GRAPHIC_SIZES = ["square", "portrait", "story"] as const;
export type PressGraphic = {
  layout: (typeof GRAPHIC_LAYOUTS)[number]; size: (typeof GRAPHIC_SIZES)[number]; headline: string; statement: string; kicker: string; field: string;
  accent: string;
};

export const pressItems = pgTable(
  "press_items",
  {
    id: id(),
    organizationId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().$type<PressKind>().notNull().default("statement"),
    headline: text().notNull(),
    body: text().notNull().default(""),
    billId: uuid().references(() => bills.id, { onDelete: "set null" }),
    status: text().$type<"draft" | "approved">().notNull().default("draft"),
    aiGenerated: boolean().notNull().default(false),
    graphic: jsonb().$type<PressGraphic>(),
    authorId: uuid().references(() => users.id, { onDelete: "set null" }),
    approvedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("press_items_updated_idx").on(t.organizationId, t.updatedAt)],
);
