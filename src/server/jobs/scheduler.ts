import { eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { emailConnections, organizations } from "../db/schema";
import { getEnv } from "../env";
import { logger } from "../logger";
import { enqueue } from "./queue";
import { providerFor } from "../legislation/sync";
import { PIPELINE_VERSION } from "../classification/schema";

// Time-bucketed keys: any number of schedulers enqueue each job once a period.
async function scheduleDueJobs(now = new Date()) {
  const dayKey = now.toISOString().slice(0, 10);
  const sixHour = `${dayKey}T${String(Math.floor(now.getUTCHours() / 6) * 6).padStart(2, "0")}`;
  const hour = `${dayKey}T${String(now.getUTCHours()).padStart(2, "0")}`;
  const tenMin = `${hour}:${String(Math.floor(now.getUTCMinutes() / 10) * 10).padStart(2, "0")}`;
  const db = await systemDb();

  await enqueue("mail.renew_subscriptions", {}, { idempotencyKey: `renew:${dayKey}` });
  const conns = await db.select({ id: emailConnections.id, orgId: emailConnections.organizationId }).from(emailConnections)
    .where(eq(emailConnections.status, "active"));
  for (const c of conns) {
    if (now.getUTCHours() >= 7) await enqueue("mail.reconcile", { connectionId: c.id }, { orgId: c.orgId, idempotencyKey: `reconcile:${c.id}:${dayKey}` });
    await enqueue("mail.incremental", { connectionId: c.id }, { orgId: c.orgId, idempotencyKey: `poll:${c.id}:${tenMin}` });
  }

  const offices = await db.select({ id: organizations.id }).from(organizations);
  for (const o of offices) await enqueue("mail.reread", {}, { orgId: o.id, idempotencyKey: `reread:${o.id}:${PIPELINE_VERSION}:${dayKey}` });

  const jurisdictions = await db.selectDistinct({ code: organizations.jurisdictionCode }).from(organizations);
  for (const j of jurisdictions) {
    const provider = providerFor(j.code);
    // A snapshot only changes on deploy, so a scheduled sync would fake freshness.
    if (provider && !provider.snapshotBuiltAt) {
      await enqueue("legislation.sync", { jurisdiction: j.code }, { idempotencyKey: `legsync:${j.code}:${provider.wholeSession ? hour : sixHour}` });
    }
  }

  return { at: now.toISOString() };
}

export function startScheduler(intervalMs = 60_000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await scheduleDueJobs();
    } catch (e) {
      logger.error("scheduler.failed", { message: (e as Error).message });
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 5_000);
  logger.info("scheduler.started", { env: getEnv().APP_ENV });
  return () => {
    stopped = true;
  };
}

