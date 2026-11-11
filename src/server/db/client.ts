import path from "node:path";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { getEnv } from "../env";
import { notFound } from "../errors";

type Schema = typeof schema;
export type Db = PgDatabase<NodePgQueryResultHKT, Schema>;

type Holder = { db: Db; close: () => Promise<void>; kind: "pg" | "pglite"; ready: Promise<void> };

const g = globalThis as unknown as { __liDb?: Holder };

async function createPglite(url: string): Promise<Holder> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { drizzle } = await import("drizzle-orm/pglite");
  const target = url.replace(/^pglite:\/\//, "");
  const dataDir = target === "memory" || target === "" ? undefined : path.resolve(process.cwd(), target);
  if (dataDir) (await import("node:fs")).mkdirSync(path.dirname(dataDir), { recursive: true });
  // In-memory needs the one-argument form; (undefined, options) drops the options.
  const client = dataDir ? new PGlite(dataDir, { extensions: { vector } }) : new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema, casing: "snake_case" }) as unknown as Db;
  return { db, kind: "pglite", ready: client.waitReady, close: () => client.close() };
}

async function createPg(url: string): Promise<Holder> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  const db = drizzle(pool, { schema, casing: "snake_case" }) as unknown as Db;
  return { db, kind: "pg", ready: Promise.resolve(), close: () => pool.end() };
}

let pending: Promise<Holder> | undefined;

async function holder(): Promise<Holder> {
  if (g.__liDb) return g.__liDb;
  if (!pending) {
    const url = getEnv().DATABASE_URL;
    pending = (url.startsWith("pglite://") ? createPglite(url) : createPg(url)).then(async (h) => {
      await h.ready;
      g.__liDb = h;
      return h;
    });
  }
  return pending;
}

// Owner connection, bypasses RLS. Tenant data goes through withTenant().
export async function systemDb(): Promise<Db> {
  return (await holder()).db;
}

export async function dbKind() {
  return (await holder()).kind;
}

type TenantScope = { orgId: string; userId?: string | null };

// Bad input, not a fault: malformed id, null character, number out of range.
const REFUSED_VALUE = new Set(["22P02", "22021", "22003"]);
const refusedValue = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return REFUSED_VALUE.has(err?.code ?? "") || REFUSED_VALUE.has(err?.cause?.code ?? "");
};

// Runs as li_app with app.org_id set, so RLS enforces tenant isolation too.
export async function withTenant<T>(scope: TenantScope, fn: (tx: Db) => Promise<T>): Promise<T> {
  const db = await systemDb();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${scope.orgId}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`);
      await tx.execute(sql`set local role li_app`);
      return fn(tx as unknown as Db);
    });
  } catch (e) {
    if (refusedValue(e)) throw Object.assign(notFound(), { cause: e });
    throw e;
  }
}

export async function closeDb() {
  const h = g.__liDb;
  g.__liDb = undefined;
  pending = undefined;
  if (h) await h.close();
}

export function setDbForTests(h: { db: Db; close: () => Promise<void>; kind: "pg" | "pglite" }) {
  g.__liDb = { ...h, ready: Promise.resolve() };
  pending = undefined;
}

export { schema };
