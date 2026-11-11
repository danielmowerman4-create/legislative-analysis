export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("./server/env");
  const env = getEnv();
  const { dbKind } = await import("./server/db/client");
  if ((await dbKind()) === "pglite") {
    const { runMigrations } = await import("./server/db/migrate");
    await runMigrations();
    const { keepStatisticsFresh } = await import("./server/db/maintenance");
    keepStatisticsFresh();
  }
  if (env.APP_ENV === "demo") {
    const { registerDemoProviders } = await import("./server/demo/register");
    registerDemoProviders();
  }
  if (env.WORKER_MODE === "inline") {
    const { startPollingWorker } = await import("./server/jobs/runner");
    const { startScheduler } = await import("./server/jobs/scheduler");
    startPollingWorker({ concurrency: 2 });
    startScheduler();
  }
}
