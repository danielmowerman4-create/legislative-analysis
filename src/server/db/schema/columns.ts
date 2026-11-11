import { customType, timestamp, uuid } from "drizzle-orm/pg-core";

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const id = () => uuid().primaryKey().defaultRandom();
export const orgId = () => uuid().notNull();
export const createdAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();
export const ts = () => timestamp({ withTimezone: true });

export type EvidenceSpan = { start: number; end: number; text: string; field?: "substantive" | "subject" };
