import { and, eq, lt, sql } from "drizzle-orm";
import { systemDb, type Db } from "../db/client";
import { backgroundJobs } from "../db/schema";
import { getEnv } from "../env";
import { logger } from "../logger";

export type JobName = "message.classify" | "contact.locate" | "mail.backfill" | "mail.fetch_batch" | "mail.incremental" | "mail.renew_subscriptions" |
  "mail.reconcile" | "mail.reread" | "mail.reattribute" | "reply.deliver" | "legislation.sync" | "legislation.alerts";

export const QUEUES: Record<JobName, string> = {
  "message.classify": "classify", "contact.locate": "classify", "mail.backfill": "mail", "mail.fetch_batch": "mail", "mail.incremental": "mail",
  "mail.renew_subscriptions": "mail", "mail.reconcile": "mail", "mail.reread": "classify", "mail.reattribute": "classify", "reply.deliver": "mail",
  "legislation.sync": "legislation", "legislation.alerts": "legislation",
};

type EnqueueOptions = { orgId?: string | null; idempotencyKey?: string; runAt?: Date; maxAttempts?: number };

export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export class PermanentJobError extends Error {}

// With `tx`, the job commits with the caller's writes (outbox pattern).
export async function enqueue(name: JobName, payload: Record<string, unknown>, opts: EnqueueOptions = {}, tx?: Db) {
  const db = tx ?? (await systemDb());
  const [row] = await db.insert(backgroundJobs)
    .values({
      queue: QUEUES[name], name, payload, organizationId: opts.orgId ?? null, idempotencyKey: opts.idempotencyKey ?? null, runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: backgroundJobs.idempotencyKey }).returning({ id: backgroundJobs.id });
  if (row && getEnv().REDIS_URL && !tx) {
    const { pushToBullmq } = await import("./bullmq-driver");
    await pushToBullmq(row.id, name, opts.runAt);
  }
  return row?.id ?? null;
}

export type ClaimedJob = typeof backgroundJobs.$inferSelect;

function backoffMs(attempt: number) {
  const base = Math.min(15_000 * 2 ** (attempt - 1), 30 * 60_000);
  return base + Math.floor(Math.random() * base * 0.2);
}

export async function claimJobs(workerId: string, queues: string[], limit: number): Promise<ClaimedJob[]> {
  const db = await systemDb();
  const res = await db.execute<ClaimedJob>(sql`
    update background_jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    where id in (
      select id from background_jobs
      where status = 'queued' and run_at <= now() and queue in ${sql.raw(`(${queues.map((q) => `'${q.replace(/'/g, "")}'`).join(",")})`)}
      -- A reply a person just pressed Send on goes ahead of a backlog of reading.
      order by (name = 'reply.deliver') desc, run_at
      limit ${limit}
      for update skip locked
    )
    returning id, queue, name, organization_id as "organizationId", payload, idempotency_key as "idempotencyKey", status, attempts,
      max_attempts as "maxAttempts", run_at as "runAt", locked_at as "lockedAt", locked_by as "lockedBy", last_error as "lastError",
      result, created_at as "createdAt", finished_at as "finishedAt"`);
  return res.rows;
}

export async function completeJob(id: string, result: Record<string, unknown> | undefined) {
  const db = await systemDb();
  await db.update(backgroundJobs).set({ status: "succeeded", result: result ?? null, finishedAt: new Date(), lockedAt: null, lastError: null })
    .where(eq(backgroundJobs.id, id));
}

export async function failJob(job: ClaimedJob, error: unknown) {
  const db = await systemDb();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const permanent = error instanceof PermanentJobError;
  if (permanent || job.attempts >= job.maxAttempts) {
    await db.update(backgroundJobs).set({ status: "dead", lastError: message, finishedAt: new Date(), lockedAt: null }).where(eq(backgroundJobs.id, job.id));
    logger.error("job.dead", { id: job.id, name: job.name, attempts: job.attempts, error: message });
    return "dead" as const;
  }
  const delay = error instanceof RetryLaterError ? error.retryAfterMs : backoffMs(job.attempts);
  await db.update(backgroundJobs).set({ status: "queued", lastError: message, runAt: new Date(Date.now() + delay), lockedAt: null, lockedBy: null })
    .where(eq(backgroundJobs.id, job.id));
  logger.warn("job.retry", { id: job.id, name: job.name, attempts: job.attempts, delayMs: delay });
  return "retry" as const;
}

export async function requeueStale(olderThanMs = 10 * 60_000) {
  const db = await systemDb();
  await db.update(backgroundJobs).set({ status: "queued", lockedAt: null, lockedBy: null, lastError: "worker lost lock" })
    .where(and(eq(backgroundJobs.status, "running"), lt(backgroundJobs.lockedAt, new Date(Date.now() - olderThanMs))));
}
