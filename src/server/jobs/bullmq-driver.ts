import { Queue, Worker } from "bullmq";
import { getEnv } from "../env";
import { logger } from "../logger";
import { QUEUES, type JobName } from "./queue";

// The Postgres ledger owns job state; BullMQ only delivers ledger ids.

const queues = new Map<string, Queue>();

function connection() {
  const url = new URL(getEnv().REDIS_URL!);
  return {
    host: url.hostname, port: Number(url.port || 6379), password: url.password || undefined, username: url.username || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined, maxRetriesPerRequest: null,
  };
}

function queueFor(name: string) {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(`li-${name}`, { connection: connection() });
    queues.set(name, q);
  }
  return q;
}

export async function pushToBullmq(ledgerId: string, name: JobName, runAt?: Date) {
  const delay = runAt ? Math.max(0, runAt.getTime() - Date.now()) : 0;
  await queueFor(QUEUES[name]).add(name, { ledgerId }, { jobId: ledgerId, delay, removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 });
}

export function startBullmqWorkers(run: (ledgerId: string) => Promise<void>, concurrency: Record<string, number>) {
  const workers = Object.entries(concurrency)
    .map(([queue, n]) => new Worker(`li-${queue}`, async (job) => {
      await run(String(job.data.ledgerId));
    }, { connection: connection(), concurrency: n }));
  for (const w of workers) w.on("failed", (job, err) => logger.error("bullmq.failed", { id: job?.id, error: err.message }));
  return () => Promise.all(workers.map((w) => w.close()));
}
