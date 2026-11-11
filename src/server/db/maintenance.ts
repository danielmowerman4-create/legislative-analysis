import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { dbKind, systemDb } from "./client";

let running = false;

// PGlite never analyzes by itself, so it plans reads as if tables were empty.
async function refreshStatistics() {
  if (running || (await dbKind()) !== "pglite") return;
  running = true;
  try {
    const db = await systemDb();
    await db.execute(sql`analyze`);
  } catch (e) {
    logger.warn("db.statistics_failed", { message: (e as Error).message });
  } finally {
    running = false;
  }
}

let lastRun = 0;

export function refreshStatisticsSoon() {
  if (Date.now() - lastRun < 120_000) return;
  lastRun = Date.now();
  void refreshStatistics();
}

export function keepStatisticsFresh(everyMs = 30 * 60_000) {
  void refreshStatistics();
  const timer = setInterval(() => void refreshStatistics(), everyMs);
  timer.unref?.();
}
