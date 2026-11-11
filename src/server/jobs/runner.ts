import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { systemDb } from "../db/client";
import { backgroundJobs } from "../db/schema";
import { logger } from "../logger";
import { claimJobs, completeJob, failJob, PermanentJobError, requeueStale, type ClaimedJob, type JobName } from "./queue";

const HEARTBEAT_MS = 60_000;
const ALL_QUEUES = ["classify", "mail", "legislation"];

type Handler = (payload: Record<string, unknown>, job: ClaimedJob) => Promise<Record<string, unknown> | void>;

const HANDLERS: Record<JobName, () => Promise<Handler>> = {
  "message.classify": async () => {
    const { classifyMessage } = await import("../services/classify");
    return async (p, job) => {
      const r = await classifyMessage(job.organizationId!, String(p.messageId), { rulesOnly: p.rulesOnly === true });
      return { review: r?.requires_staff_review ?? null };
    };
  }, "contact.locate": async () => {
    const { locateAddress } = await import("../services/district");
    return async (p, job) => locateAddress(job.organizationId!, String(p.addressId));
  }, "mail.backfill": async () => (await import("../email/sync")).handleBackfill,
  "mail.fetch_batch": async () => (await import("../email/sync")).handleFetchBatch,
  "mail.incremental": async () => (await import("../email/sync")).handleIncremental,
  "mail.renew_subscriptions": async () => (await import("../email/sync")).handleRenewSubscriptions,
  "mail.reconcile": async () => (await import("../email/sync")).handleReconcile, "mail.reread": async () => {
    const { rereadOlderReadings } = await import("../services/classify");
    return async (p, job) => rereadOlderReadings(
      job.organizationId!, typeof p.after === "string" ? p.after : null,
      p.changed === true ? new Date().toISOString() : typeof p.readBefore === "string" ? p.readBefore : null,
    );
  }, "mail.reattribute": async () => {
    const { reattributeSender } = await import("../services/reattribute");
    return async (p, job) => reattributeSender(job.organizationId!, String(p.ruleId), job.id);
  }, "reply.deliver": async () => {
    const { deliverReply } = await import("../services/replies");
    const { AppError } = await import("../errors");
    return async (p, job) => {
      try {
        return { result: await deliverReply(job.organizationId!, String(p.deliveryId)) };
      } catch (e) {
        // A refused copy waits for a person; retrying by itself would not help.
        if (e instanceof AppError) throw new PermanentJobError(e.message);
        throw e;
      }
    };
  }, "legislation.sync": async () => (await import("../legislation/sync")).handleLegislativeSync,
  "legislation.alerts": async () => (await import("../legislation/alerts")).handleLegislativeAlerts,
};

async function runJob(job: ClaimedJob) {
  const started = Date.now();
  // Keep the lock fresh or the stale sweep hands the job to another worker.
  const heartbeat = setInterval(() => {
    void systemDb()
      .then((db) => db.update(backgroundJobs).set({ lockedAt: new Date() }).where(eq(backgroundJobs.id, job.id)))
      .catch((e: Error) => logger.warn("job.heartbeat_failed", { id: job.id, message: e.message }));
  }, HEARTBEAT_MS);
  try {
    const handler = await HANDLERS[job.name as JobName]();
    const result = await handler(job.payload, job);
    await completeJob(job.id, result ?? undefined);
    logger.info("job.ok", { id: job.id, name: job.name, ms: Date.now() - started });
    return "ok" as const;
  } catch (error) {
    return failJob(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runLedgerJob(id: string) {
  const db = await systemDb();
  const [job] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id));
  if (!job || job.status !== "queued") return;
  await db.update(backgroundJobs).set({ status: "running", lockedAt: new Date(), attempts: job.attempts + 1 }).where(eq(backgroundJobs.id, id));
  await runJob({ ...job, attempts: job.attempts + 1 });
}

export async function drainJobs(queues = ALL_QUEUES, maxRounds = 50) {
  const workerId = `drain-${randomUUID().slice(0, 8)}`;
  let processed = 0;
  for (let round = 0; round < maxRounds; round++) {
    const jobs = await claimJobs(workerId, queues, 20);
    if (!jobs.length) break;
    for (const job of jobs) {
      await runJob(job);
      processed++;
    }
  }
  return processed;
}

export function startPollingWorker(opts: { queues?: string[]; concurrency?: number; pollMs?: number } = {}) {
  const queues = opts.queues ?? ALL_QUEUES;
  const concurrency = opts.concurrency ?? 4;
  const pollMs = opts.pollMs ?? 1500;
  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 6)}`;
  let stopped = false;
  let inFlight = 0;
  let lastSweep = 0;
  let looking = false;
  let lookAgain = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const lookIn = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(look, ms);
  };

  const look = async () => {
    timer = null;
    if (stopped) return;
    if (looking) {
      lookAgain = true;
      return;
    }
    looking = true;
    let claimed = 0;
    try {
      if (Date.now() - lastSweep > 60_000) {
        lastSweep = Date.now();
        await requeueStale();
      }
      const free = concurrency - inFlight;
      if (free > 0) {
        const jobs = await claimJobs(workerId, queues, free);
        claimed = jobs.length;
        for (const job of jobs) {
          inFlight++;
          void runJob(job).finally(() => {
            inFlight--;
            lookIn(10);
          });
        }
      }
    } catch (error) {
      logger.error("worker.tick_failed", { message: (error as Error).message });
    }
    looking = false;
    if (lookAgain) {
      lookAgain = false;
      lookIn(10);
    } else if (!claimed && !timer) lookIn(pollMs);
  };
  lookIn(250);
  logger.info("worker.started", { workerId, queues, concurrency });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
