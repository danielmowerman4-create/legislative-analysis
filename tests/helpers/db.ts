import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { closeDb, setDbForTests, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import * as schema from "@/server/db/schema";
import { createOffice } from "@/server/services/offices";
import { loadSession, createSession } from "@/server/auth/sessions";
import type { OfficeContext } from "@/server/authz/context";

export async function freshDatabase() {
  await closeDb();
  const client = new PGlite({ extensions: { vector } });
  await client.waitReady;
  const db = drizzle(client, { schema, casing: "snake_case" }) as unknown as Db;
  setDbForTests({ db, kind: "pglite", close: () => client.close() });
  await runMigrations();
  return { db, client };
}

let seq = 0;

export async function makeOffice(overrides: Partial<{ jurisdictionCode: string; name: string; internalDomains: string[] }> = {}) {
  seq += 1;
  const slug = `office-${seq}-${Math.random().toString(36).slice(2, 7)}`;
  const { orgId, ownerId } = await createOffice({
    name: overrides.name ?? `Office ${seq}`,
    slug,
    jurisdictionCode: overrides.jurisdictionCode ?? "ZZ",
    chamber: "lower",
    district: "42",
    legislatorName: "Rep. Test",
    internalDomains: overrides.internalDomains ?? ["house.example.gov"],
    owner: { email: `owner-${slug}@example.test`, name: `Owner ${seq}`, password: "correct horse battery staple" },
  });
  const ctx = await contextFor(ownerId);
  return { orgId, ownerId, ctx };
}

export async function contextFor(userId: string, orgId?: string): Promise<OfficeContext> {
  const token = await createSession(userId, { orgId, mfaVerified: true });
  const s = await loadSession(token);
  if (!s?.ctx) throw new Error("no context");
  return s.ctx;
}

// Drizzle wraps driver errors; the Postgres message is on `cause`.
export async function expectDbError(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    const msg = `${err.message} ${err.cause?.message ?? ""}`;
    if (!pattern.test(msg)) throw new Error(`Expected error matching ${pattern}, got: ${msg.slice(0, 300)}`);
    return;
  }
  throw new Error(`Expected an error matching ${pattern}, but the operation succeeded`);
}
