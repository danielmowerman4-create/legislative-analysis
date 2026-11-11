import { forbidden } from "../errors";
import { ALL_PERMISSIONS, type Permission, type RoleKey } from "./permissions";

export type OfficeContext = { userId: string; orgId: string; roleKey: RoleKey | string; permissions: ReadonlySet<Permission>; actor: "user" | "system" };

export const tenantScope = (ctx: OfficeContext) => ({ orgId: ctx.orgId, userId: ctx.userId });

export function can(ctx: OfficeContext, permission: Permission) {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: OfficeContext, ...required: Permission[]) {
  for (const p of required) {
    if (!ctx.permissions.has(p)) throw forbidden();
  }
}

export function systemContext(orgId: string): OfficeContext {
  return { userId: "00000000-0000-0000-0000-000000000000", orgId, roleKey: "system", permissions: new Set(ALL_PERMISSIONS), actor: "system" };
}

export const actorId = (ctx: OfficeContext) => (ctx.actor === "system" ? null : ctx.userId);
