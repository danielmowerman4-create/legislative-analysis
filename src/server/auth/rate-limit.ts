import { sql } from "drizzle-orm";
import { systemDb } from "../db/client";
import { AppError } from "../errors";

export async function hitRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number }> {
  const db = await systemDb();
  const res = await db.execute<{ count: number }>(sql`
    insert into rate_limits (key, count, window_start) values (${key}, 1, now())
    on conflict (key) do update set
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else rate_limits.count + 1 end,
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else rate_limits.window_start end
    returning count`);
  const count = Number(res.rows[0]?.count ?? 1);
  return { allowed: count <= limit, count };
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number) {
  const r = await hitRateLimit(key, limit, windowSeconds);
  if (!r.allowed) throw new AppError("rate_limited", "Too many attempts. Wait a few minutes and try again.");
}
