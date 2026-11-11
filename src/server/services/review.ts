import { and, eq } from "drizzle-orm";
import { withTenant } from "../db/client";
import { reviewQueue } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { notFound } from "../errors";
import { refreshRequiresReview } from "./corrections";

export async function dismissReview(ctx: OfficeContext, id: string, resolution = "dismissed") {
  requirePermission(ctx, "classification.review");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [r] = await tx.update(reviewQueue).set({ status: "dismissed", resolvedBy: ctx.userId, resolvedAt: new Date(), resolution })
      .where(and(eq(reviewQueue.id, id), eq(reviewQueue.organizationId, ctx.orgId))).returning();
    if (!r) throw notFound();
    if (r.messageId) await refreshRequiresReview(tx, r.messageId);
  });
}
