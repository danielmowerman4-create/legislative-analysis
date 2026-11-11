import { and, eq, isNull, sql } from "drizzle-orm";
import { systemDb } from "../db/client";
import { memberships, officeSettings, organizations, rolePermissions, roles, securityEvents, sessions, users } from "../db/schema";
import { decryptSecret, encryptSecret, hashIp, randomToken, sha256 } from "../crypto";
import { AppError } from "../errors";
import type { OfficeContext } from "../authz/context";
import type { Permission } from "../authz/permissions";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "./password";
import { enforceRateLimit, hitRateLimit } from "./rate-limit";
import { generateTotpSecret, verifyTotp } from "./totp";

export const SESSION_COOKIE = "li_session";
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 12 * 3600 * 1000;
const PASSWORD_MAX_LENGTH = 200;

type SessionUser = { id: string; email: string; name: string; themePreference: "system" | "light" | "dark"; mfaEnabled: boolean };
type SessionOrg = {
  id: string; name: string; jurisdictionCode: string; legislatorName: string | null; district: string | null; chamber: string; isDemo: boolean;
};

export type LoadedSession = {
  sessionId: string; user: SessionUser; mfaVerified: boolean; mfaRequiredByOffice: boolean; passwordChangeRequired: boolean; org: SessionOrg | null;
  ctx: OfficeContext | null; offices: { id: string; name: string }[];
};

const isLive = (s: { revokedAt: Date | null; disabledAt: Date | null; expiresAt: Date; lastSeenAt: Date }, now = Date.now()) =>
  !s.revokedAt && !s.disabledAt && s.expiresAt.getTime() >= now && s.lastSeenAt.getTime() + SESSION_IDLE_MS >= now;

export async function logSecurity(event: string, opts: { userId?: string; email?: string; ip?: string | null }) {
  const db = await systemDb();
  await db.insert(securityEvents).values({ event, userId: opts.userId, email: opts.email?.toLowerCase(), ipHash: hashIp(opts.ip) });
}

export async function createSession(userId: string, opts: { orgId?: string | null; mfaVerified: boolean; ip?: string | null; userAgent?: string | null }) {
  const db = await systemDb();
  const token = randomToken(32);
  await db.insert(sessions).values({
    tokenHash: sha256(token), userId, activeOrgId: opts.orgId ?? null, mfaVerified: opts.mfaVerified, ipHash: hashIp(opts.ip),
    userAgent: opts.userAgent?.slice(0, 300) ?? null, expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_MS),
  });
  return token;
}

export async function revokeSession(token: string) {
  const db = await systemDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeAllSessions(userId: string) {
  const db = await systemDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function loginWithPassword(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const normalized = email.trim().toLowerCase();
  const ip = hashIp(meta.ip) ?? "unknown";
  await enforceRateLimit(`login:ip:${ip}`, 30, 900);
  // Per account and address too, so locking someone out takes many addresses.
  await enforceRateLimit(`login:acct-ip:${sha256(normalized)}:${ip}`, 10, 900);
  await enforceRateLimit(`login:acct:${sha256(normalized)}`, 100, 900);
  const db = await systemDb();
  const [user] = await db.select({ id: users.id, passwordHash: users.passwordHash, mfaEnabledAt: users.mfaEnabledAt, disabledAt: users.disabledAt }).from(users)
    .where(sql`lower(${users.email}) = ${normalized}`).limit(1);
  const ok = await verifyPassword(password, user?.passwordHash);
  if (!user || !ok || user.disabledAt) {
    await logSecurity("login_failed", { email: normalized, ip: meta.ip, userId: user?.id });
    throw new AppError("unauthorized", "Email or password is incorrect.");
  }
  const [firstMembership] = await db.select({ orgId: memberships.organizationId }).from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"))).orderBy(memberships.createdAt).limit(1);
  const mfaPending = Boolean(user.mfaEnabledAt);
  const token = await createSession(user.id, { orgId: firstMembership?.orgId ?? null, mfaVerified: !mfaPending, ...meta });
  if (!mfaPending) await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await logSecurity(mfaPending ? "login_password_ok_mfa_pending" : "login_succeeded", { userId: user.id, ip: meta.ip });
  return { token, mfaPending };
}

export async function changePassword(userId: string, current: string, next: string, meta: { ip?: string | null }) {
  await enforceRateLimit(`password:${userId}`, 10, 900);
  const db = await systemDb();
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId)).limit(1);
  if (!(await verifyPassword(current, user?.passwordHash))) {
    await logSecurity("password_change_failed", { userId, ip: meta.ip });
    throw new AppError("validation", "Your current password is not correct.");
  }
  if (next.length < PASSWORD_MIN_LENGTH) throw new AppError("validation", `Your new password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (next.length > PASSWORD_MAX_LENGTH) throw new AppError("validation", `Your new password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`);
  if (next === current) throw new AppError("validation", "Choose a password different from your current one.");
  await db.update(users).set({ passwordHash: await hashPassword(next), mustChangePassword: false }).where(eq(users.id, userId));
  await logSecurity("password_changed", { userId, ip: meta.ip });
}

export async function completeMfa(token: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const db = await systemDb();
  const [row] = await db.select({
    sessionId: sessions.id, userId: sessions.userId, orgId: sessions.activeOrgId, secret: users.mfaSecretEnc, revokedAt: sessions.revokedAt,
    expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt, disabledAt: users.disabledAt,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.tokenHash, sha256(token))).limit(1);
  if (!row || !row.secret || !isLive(row)) throw new AppError("unauthorized", "Sign in again.");
  await enforceRateLimit(`mfa:${row.userId}`, 10, 900);
  if (!verifyTotp(decryptSecret(row.secret), code)) {
    await logSecurity("mfa_failed", { userId: row.userId, ip: meta.ip });
    throw new AppError("unauthorized", "That code is not valid. Check your authenticator app and try again.");
  }
  // Replay guard: 90 s covers the whole window verifyTotp accepts.
  if (!(await hitRateLimit(`totp-used:${row.userId}:${code.replace(/\s/g, "")}`, 1, 90)).allowed) {
    await logSecurity("mfa_replayed", { userId: row.userId, ip: meta.ip });
    throw new AppError("unauthorized", "That code was already used. Wait for the next one in your authenticator app.");
  }
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, row.sessionId));
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.userId));
  await logSecurity("login_succeeded_mfa", { userId: row.userId, ip: meta.ip });
  return createSession(row.userId, { orgId: row.orgId, mfaVerified: true, ...meta });
}

async function assertMayEnroll(userId: string) {
  const db = await systemDb();
  const [u] = await db.select({ enabledAt: users.mfaEnabledAt, mustChange: users.mustChangePassword }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new AppError("unauthorized", "Sign in again.");
  if (u.enabledAt) throw new AppError("forbidden", "Two-step verification is already on. To move it to a new device, ask an owner to reset it from Team.");
  if (u.mustChange) throw new AppError("forbidden", "Choose your own password first.");
}

export async function beginMfaEnrollment(userId: string) {
  await assertMayEnroll(userId);
  const secret = generateTotpSecret();
  return { secret, secretEnc: encryptSecret(secret) };
}

export async function confirmMfaEnrollment(userId: string, secretEnc: string, code: string) {
  await assertMayEnroll(userId);
  if (!verifyTotp(decryptSecret(secretEnc), code)) throw new AppError("validation", "That code does not match. Scan the key again and enter the current code.");
  const db = await systemDb();
  // Guarded again in the write so two confirmations can't both replace a factor.
  const [on] = await db.update(users).set({ mfaSecretEnc: secretEnc, mfaEnabledAt: new Date() }).where(and(eq(users.id, userId), isNull(users.mfaEnabledAt)))
    .returning({ id: users.id });
  if (!on) throw new AppError("forbidden", "Two-step verification is already on.");
  await logSecurity("mfa_enabled", { userId });
}

export async function switchOffice(token: string, orgId: string) {
  const db = await systemDb();
  const [s] = await db.select({ id: sessions.id, userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, sha256(token))).limit(1);
  if (!s) throw new AppError("unauthorized", "Sign in again.");
  const [m] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.userId, s.userId), eq(memberships.organizationId, orgId), eq(memberships.status, "active"))).limit(1);
  if (!m) throw new AppError("forbidden", "You are not a member of that office.");
  await db.update(sessions).set({ activeOrgId: orgId }).where(eq(sessions.id, s.id));
}

export async function loadSession(token: string | undefined | null): Promise<LoadedSession | null> {
  if (!token) return null;
  const db = await systemDb();
  const [row] = await db.select({
    sessionId: sessions.id, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt, mfaVerified: sessions.mfaVerified,
    activeOrgId: sessions.activeOrgId, userId: users.id, email: users.email, name: users.name, theme: users.themePreference, mfaEnabledAt: users.mfaEnabledAt,
    mustChangePassword: users.mustChangePassword, disabledAt: users.disabledAt,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(eq(sessions.tokenHash, sha256(token))).limit(1);
  const now = Date.now();
  if (!row || !isLive(row, now)) return null;
  if (now - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }

  const offices = await db.select({ id: organizations.id, name: organizations.name }).from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId)).where(and(eq(memberships.userId, row.userId), eq(memberships.status, "active")))
    .orderBy(organizations.name);

  const user: SessionUser = { id: row.userId, email: row.email, name: row.name, themePreference: row.theme, mfaEnabled: Boolean(row.mfaEnabledAt) };
  const orgId = offices.find((o) => o.id === row.activeOrgId)?.id ?? offices[0]?.id ?? null;
  const passwordChangeRequired = row.mustChangePassword;
  const noOffice: LoadedSession = {
    sessionId: row.sessionId, user, mfaVerified: row.mfaVerified, mfaRequiredByOffice: false, passwordChangeRequired, org: null, ctx: null, offices,
  };
  if (!orgId || !row.mfaVerified) return noOffice;

  const [m] = await db.select({ roleId: memberships.roleId, roleKey: roles.key, org: organizations, requireMfa: officeSettings.requireMfa }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .leftJoin(officeSettings, eq(officeSettings.organizationId, memberships.organizationId))
    .where(and(eq(memberships.userId, row.userId), eq(memberships.organizationId, orgId), eq(memberships.status, "active"))).limit(1);
  if (!m) return noOffice;

  const perms = await db.select({ key: rolePermissions.permissionKey }).from(rolePermissions).where(eq(rolePermissions.roleId, m.roleId));
  const org: SessionOrg = {
    id: m.org.id, name: m.org.name, jurisdictionCode: m.org.jurisdictionCode, legislatorName: m.org.legislatorName, district: m.org.district,
    chamber: m.org.chamber, isDemo: m.org.isDemo,
  };
  const ctx: OfficeContext = { userId: row.userId, orgId, roleKey: m.roleKey, permissions: new Set(perms.map((p) => p.key as Permission)), actor: "user" };
  return {
    sessionId: row.sessionId, user, mfaVerified: true, mfaRequiredByOffice: Boolean(m.requireMfa) && !user.mfaEnabled, passwordChangeRequired, org, ctx,
    offices,
  };
}
