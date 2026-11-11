import path from "node:path";
import { dbKind, systemDb } from "./client";

export async function runMigrations(folder = path.resolve(process.cwd(), "drizzle")) {
  const db = await systemDb();
  const { migrate } = (await dbKind()) === "pglite" ? await import("drizzle-orm/pglite/migrator") : await import("drizzle-orm/node-postgres/migrator");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await migrate(db as any, { migrationsFolder: folder });
}
