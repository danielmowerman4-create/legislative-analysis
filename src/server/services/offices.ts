import { and, eq, ne, sql } from "drizzle-orm";
import { systemDb, withTenant, type Db } from "../db/client";
import { jurisdictions, memberships, officeSettings, organizations, permissions, rolePermissions, roles, users } from "../db/schema";
import { PERMISSIONS, ROLE_TEMPLATES, type RoleKey } from "../authz/permissions";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../auth/password";
import { logSecurity, revokeAllSessions } from "../auth/sessions";
import { AppError } from "../errors";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { audit } from "./audit";

export const KNOWN_JURISDICTIONS: Record<string, { name: string; classification: "state" | "demo"; timezone: string }> = {
  GA: { name: "Georgia", classification: "state", timezone: "America/New_York" },
  CT: { name: "Connecticut", classification: "state", timezone: "America/New_York" },
  ZZ: { name: "Demo State", classification: "demo", timezone: "America/New_York" },
};

export async function ensurePermissionsCatalog() {
  const db = await systemDb();
  await db.insert(permissions).values(Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })))
    .onConflictDoUpdate({ target: permissions.key, set: { description: sql`excluded.description` } });
}

export async function ensureJurisdiction(code: string, name?: string) {
  const db = await systemDb();
  const known = KNOWN_JURISDICTIONS[code];
  await db.insert(jurisdictions)
    .values({ code, name: name ?? known?.name ?? code, classification: known?.classification ?? "state", timezone: known?.timezone ?? "America/New_York" })
    .onConflictDoNothing();
}

type CreateOfficeInput = {
  name: string; slug: string; jurisdictionCode: string; chamber: "upper" | "lower" | "other"; district?: string; legislatorName?: string;
  internalDomains?: string[]; isDemo?: boolean; owner: { email: string; name: string; password?: string; temporary?: boolean };
};

function assertPasswordLength(password: string | undefined) {
  if (password !== undefined && password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError("validation", `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}

// Platform operation (CLI and tests only), never exposed in the web app.
export async function createOffice(input: CreateOfficeInput) {
  await ensurePermissionsCatalog();
  await ensureJurisdiction(input.jurisdictionCode);
  const db = await systemDb();

  assertPasswordLength(input.owner.password);
  const passwordHash = input.owner.password ? await hashPassword(input.owner.password) : null;

  const [org] = await db.insert(organizations)
    .values({
      name: input.name, slug: input.slug, jurisdictionCode: input.jurisdictionCode, chamber: input.chamber, district: input.district,
      legislatorName: input.legislatorName, internalDomains: (input.internalDomains ?? []).map((d) => d.toLowerCase()), isDemo: input.isDemo ?? false,
    })
    .returning();

  const ownerId = await upsertUser(input.owner.email, input.owner.name, passwordHash, { temporary: input.owner.temporary });

  await withTenant({ orgId: org.id }, async (tx) => {
    const roleIds = {} as Record<RoleKey, string>;
    for (const [key, tpl] of Object.entries(ROLE_TEMPLATES) as [RoleKey, (typeof ROLE_TEMPLATES)[RoleKey]][]) {
      const [r] = await tx.insert(roles).values({ organizationId: org.id, key, name: tpl.name }).returning({ id: roles.id });
      roleIds[key] = r.id;
      await tx.insert(rolePermissions).values(tpl.permissions.map((p) => ({ organizationId: org.id, roleId: r.id, permissionKey: p })));
    }
    await tx.insert(memberships).values({ organizationId: org.id, userId: ownerId, roleId: roleIds.owner, title: "Owner" });
    await tx.insert(officeSettings).values({ organizationId: org.id });
  });
  const { enableConstituentCenter } = await import("./center");
  await enableConstituentCenter(org.id);

  return { orgId: org.id, ownerId };
}

// An existing account keeps its own password.
async function upsertUser(email: string, name: string, passwordHash: string | null, opts: { temporary?: boolean } = {}) {
  const db = await systemDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`).limit(1);
  if (existing) return existing.id;
  const [u] = await db.insert(users).values({ email: email.toLowerCase(), name, passwordHash, mustChangePassword: Boolean(opts.temporary && passwordHash) })
    .returning({ id: users.id });
  return u.id;
}

// Staff rows stay locked until written, so two owners can't remove each other.
type Seat = { owner: boolean; active: boolean };

async function guardOwners(tx: Db, ctx: OfficeContext, userId: string, next: (now: Seat) => Seat) {
  const staff = await tx.select({ userId: memberships.userId, status: memberships.status, roleKey: roles.key }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId)).where(eq(memberships.organizationId, ctx.orgId)).for("update", { of: memberships });
  const target = staff.find((m) => m.userId === userId);
  if (!target) return;
  const now = { owner: target.roleKey === "owner", active: target.status === "active" };
  if (now.owner && ctx.roleKey !== "owner") throw new AppError("forbidden", "Only an owner can change another owner.");
  const after = next(now);
  const others = staff.filter((m) => m.userId !== userId && m.roleKey === "owner" && m.status === "active").length;
  if (now.owner && now.active && !others && !(after.owner && after.active)) throw new AppError("validation", "The office must keep at least one active owner.");
}

async function roleIdFor(tx: Db, ctx: OfficeContext, key: RoleKey) {
  const [role] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.organizationId, ctx.orgId), eq(roles.key, key))).limit(1);
  if (!role) throw new AppError("validation", "Unknown role.");
  return role.id;
}

// An account already in another office is refused unless `otherOffices`.
export async function addMember(
  ctx: OfficeContext, input: { email: string; name: string; roleKey: RoleKey; title?: string; password?: string }, opts: { otherOffices?: boolean } = {},
) {
  requirePermission(ctx, "team.manage");
  if (input.roleKey === "owner" && ctx.roleKey !== "owner") throw new AppError("forbidden", "Only an owner can add another owner.");
  assertPasswordLength(input.password);
  const userId = await upsertUser(input.email, input.name, input.password ? await hashPassword(input.password) : null, { temporary: true });
  if (!opts.otherOffices) {
    const offices = await (await systemDb()).select({ orgId: memberships.organizationId }).from(memberships).where(eq(memberships.userId, userId));
    if (offices.some((m) => m.orgId !== ctx.orgId) && !offices.some((m) => m.orgId === ctx.orgId)) {
      throw new AppError("forbidden", "This person already has an account with another office, so they cannot be added here.");
    }
  }
  await withTenant(tenantScope(ctx), async (tx) => {
    const roleId = await roleIdFor(tx, ctx, input.roleKey);
    await guardOwners(tx, ctx, userId, () => ({ owner: input.roleKey === "owner", active: true }));
    await tx.insert(memberships).values({ organizationId: ctx.orgId, userId, roleId, title: input.title })
      .onConflictDoUpdate({ target: [memberships.organizationId, memberships.userId], set: { roleId, status: "active", title: input.title } });
    await audit(tx, ctx, "member.added", "membership", userId, { role: input.roleKey });
  });
  return userId;
}

export async function listTeam(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      userId: users.id, name: users.name, email: users.email, title: memberships.title, status: memberships.status, roleKey: roles.key, roleName: roles.name,
      mfaEnabledAt: users.mfaEnabledAt, lastLoginAt: users.lastLoginAt,
    }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.organizationId, ctx.orgId)).orderBy(users.name));
}

export async function setMemberRole(ctx: OfficeContext, userId: string, roleKey: RoleKey) {
  requirePermission(ctx, "team.manage");
  if (userId === ctx.userId) throw new AppError("validation", "You cannot change your own role.");
  if (roleKey === "owner" && ctx.roleKey !== "owner") throw new AppError("forbidden", "Only an owner can grant the owner role.");
  await withTenant(tenantScope(ctx), async (tx) => {
    const roleId = await roleIdFor(tx, ctx, roleKey);
    await guardOwners(tx, ctx, userId, (now) => ({ owner: roleKey === "owner", active: now.active }));
    await tx.update(memberships).set({ roleId }).where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.userId, userId)));
    await audit(tx, ctx, "member.role_changed", "membership", userId, { role: roleKey });
  });
}

export async function setMemberStatus(ctx: OfficeContext, userId: string, status: "active" | "disabled") {
  requirePermission(ctx, "team.manage");
  if (userId === ctx.userId) throw new AppError("validation", "You cannot disable yourself.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await guardOwners(tx, ctx, userId, (now) => ({ owner: now.owner, active: status === "active" }));
    await tx.update(memberships).set({ status }).where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.userId, userId)));
    await audit(tx, ctx, `member.${status}`, "membership", userId);
  });
}

// A sign-in shared with another office is not one office's to reset.
async function staffThisOfficeMayReset(ctx: OfficeContext, userId: string) {
  requirePermission(ctx, "team.manage");
  if (userId === ctx.userId) throw new AppError("validation", "Change your own sign-in from your account, not from Team.");
  const db = await systemDb();
  const rows = await db.select({ orgId: memberships.organizationId, roleKey: roles.key }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(eq(memberships.userId, userId));
  const here = rows.find((r) => r.orgId === ctx.orgId);
  if (!here) throw new AppError("not_found", "That person is not on this office's staff.");
  if (here.roleKey === "owner" && ctx.roleKey !== "owner") throw new AppError("forbidden", "Only an owner can reset another owner.");
  if (rows.some((r) => r.orgId !== ctx.orgId)) {
    throw new AppError("forbidden", "This person also belongs to another office, so one office cannot reset their sign-in.");
  }
}

export async function resetMemberPassword(ctx: OfficeContext, userId: string, temporaryPassword: string) {
  await staffThisOfficeMayReset(ctx, userId);
  assertPasswordLength(temporaryPassword);
  if (temporaryPassword.length > 200) throw new AppError("validation", "Password must be 200 characters or fewer.");
  const db = await systemDb();
  await db.update(users).set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true }).where(eq(users.id, userId));
  await revokeAllSessions(userId);
  await logSecurity("password_reset_by_office", { userId });
  await withTenant(tenantScope(ctx), (tx) => audit(tx, ctx, "member.password_reset", "membership", userId));
}

export async function resetMemberTwoStep(ctx: OfficeContext, userId: string) {
  await staffThisOfficeMayReset(ctx, userId);
  const db = await systemDb();
  await db.update(users).set({ mfaSecretEnc: null, mfaEnabledAt: null }).where(and(eq(users.id, userId), ne(users.id, ctx.userId)));
  await revokeAllSessions(userId);
  await logSecurity("mfa_reset_by_office", { userId });
  await withTenant(tenantScope(ctx), (tx) => audit(tx, ctx, "member.two_step_reset", "membership", userId));
}
