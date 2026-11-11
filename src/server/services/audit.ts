import type { Db } from "../db/client";
import { auditLogs } from "../db/schema";
import { actorId, type OfficeContext } from "../authz/context";

// Call inside the transaction that makes the change. Never log message bodies.
export async function audit(tx: Db, ctx: OfficeContext, action: string, entityType: string, entityId: string | null, summary: Record<string, unknown> = {}) {
  await tx.insert(auditLogs).values({ organizationId: ctx.orgId, actorId: actorId(ctx), action, entityType, entityId, summary });
}
