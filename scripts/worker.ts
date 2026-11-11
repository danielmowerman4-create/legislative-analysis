// npm run worker: BullMQ when REDIS_URL is set, otherwise Postgres polling.
import { getEnv } from "../src/server/env";
import { startPollingWorker, runLedgerJob } from "../src/server/jobs/runner";
import { startScheduler } from "../src/server/jobs/scheduler";
import { closeDb } from "../src/server/db/client";
import { logger } from "../src/server/logger";

async function main() {
  const env = getEnv();
  const stops: (() => unknown)[] = [];
  if (env.REDIS_URL) {
    const { startBullmqWorkers } = await import("../src/server/jobs/bullmq-driver");
    stops.push(startBullmqWorkers(runLedgerJob, { classify: 4, mail: 2, legislation: 1, ops: 1 }));
    // Postgres polling still runs for ledger retries and jobs enqueued in transactions.
    stops.push(startPollingWorker({ concurrency: 2, pollMs: 5000 }));
  } else {
    stops.push(startPollingWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4) }));
  }
  stops.push(startScheduler());
  logger.info("worker.ready", { transport: env.REDIS_URL ? "bullmq" : "postgres" });
  const shutdown = async () => {
    logger.info("worker.stopping");
    for (const s of stops) await s();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
