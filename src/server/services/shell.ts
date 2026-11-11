import { and, count, eq, sql } from "drizzle-orm";
import { withTenant } from "../db/client";
import { notifications, trackedBills } from "../db/schema";
import { tenantScope, type OfficeContext } from "../authz/context";

export async function shellCounts(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const [tracked] = await tx.select({ n: count() }).from(trackedBills).where(eq(trackedBills.organizationId, ctx.orgId));
    const [hearings] = await tx.execute<{ n: number }>(sql`
      select count(distinct e.id)::int as n from legislative_events e
      where e.status = 'scheduled' and e.starts_at >= now() and e.starts_at < now() + interval '7 days'
        and exists (select 1 from tracked_bills t where t.organization_id = ${ctx.orgId} and t.bill_id = any(e.bill_ids))`).then((r) => r.rows);
    const [unread] = await tx.select({ n: count() }).from(notifications)
      .where(and(
        eq(notifications.organizationId, ctx.orgId), sql`${notifications.readAt} is null`,
        sql`(${notifications.userId} is null or ${notifications.userId} = ${ctx.userId})`,
      ));
    return { tracked: tracked.n, hearingsThisWeek: hearings?.n ?? 0, unreadNotifications: unread.n };
  });
}
