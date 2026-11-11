import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "../db/client";
import { auditLogs, notifications, officeSettings, organizations, users } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { audit } from "./audit";
import { integrationsConfigured } from "../env";

export async function getOfficeSettings(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const [s] = await tx.select().from(officeSettings).where(eq(officeSettings.organizationId, ctx.orgId));
    return { org, settings: s, configured: integrationsConfigured() };
  });
}

export async function updateOfficeProfile(ctx: OfficeContext, patch: { name?: string; legislatorName?: string; district?: string }) {
  requirePermission(ctx, "settings.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(organizations).set(patch).where(eq(organizations.id, ctx.orgId));
    await audit(tx, ctx, "office.profile_updated", "organization", ctx.orgId, { fields: Object.keys(patch) });
  });
}

export async function updateSettings(ctx: OfficeContext, patch: Partial<{ requireMfa: boolean }>) {
  requirePermission(ctx, "settings.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ ...patch, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.updated", "office_settings", ctx.orgId, { fields: Object.keys(patch) });
  });
}

export async function listNotifications(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select().from(notifications)
      .where(and(eq(notifications.organizationId, ctx.orgId), sql`(${notifications.userId} is null or ${notifications.userId} = ${ctx.userId})`))
      .orderBy(desc(notifications.createdAt)).limit(100));
}

export async function markNotificationsRead(ctx: OfficeContext) {
  await withTenant(tenantScope(ctx), (tx) =>
    tx.update(notifications).set({ readAt: new Date() })
      .where(and(
        eq(notifications.organizationId, ctx.orgId), sql`${notifications.readAt} is null`,
        sql`(${notifications.userId} is null or ${notifications.userId} = ${ctx.userId})`,
      )));
}

export async function listAudit(ctx: OfficeContext, limit = 100) {
  requirePermission(ctx, "audit.read");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      id: auditLogs.id, action: auditLogs.action, entityType: auditLogs.entityType, entityId: auditLogs.entityId, summary: auditLogs.summary,
      createdAt: auditLogs.createdAt, actor: users.name,
    }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorId)).where(eq(auditLogs.organizationId, ctx.orgId)).orderBy(desc(auditLogs.createdAt))
      .limit(limit));
}
