import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { closeDb, systemDb } from "@/server/db/client";
import { memberships, sessions, users } from "@/server/db/schema";
import { beginMfaEnrollment, changePassword, completeMfa, confirmMfaEnrollment, loginWithPassword, revokeSession,
  SESSION_IDLE_MS } from "@/server/auth/sessions";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { totpAt } from "@/server/auth/totp";
import { sha256 } from "@/server/crypto";
import { addMember, setMemberRole, setMemberStatus } from "@/server/services/offices";

const PASSWORD = "correct horse battery staple";
const TEMPORARY = "a temporary password";
const OWN = "a password only they know";

beforeAll(freshDatabase);
afterAll(closeDb);

const emailOf = async (userId: string) => (await (await systemDb()).select({ email: users.email }).from(users).where(eq(users.id, userId)))[0].email;

describe("owners are changed only by owners, and an office keeps one", () => {
  it("refuses a chief of staff who tries to demote, disable or re-add an owner", async () => {
    const o = await makeOffice();
    const chief = await contextFor(await addMember(o.ctx, { email: "chief@owners.test", name: "Chief", roleKey: "chief_of_staff", password: PASSWORD }),
      o.orgId);
    const ownerEmail = await emailOf(o.ownerId);
    await expect(setMemberRole(chief, o.ownerId, "viewer")).rejects.toThrow(/Only an owner/);
    await expect(setMemberStatus(chief, o.ownerId, "disabled")).rejects.toThrow(/Only an owner/);
    await expect(addMember(chief, { email: ownerEmail, name: "Owner", roleKey: "viewer" })).rejects.toThrow(/Only an owner/);
    const [still] = await (await systemDb()).select({ status: memberships.status }).from(memberships).where(eq(memberships.userId, o.ownerId));
    expect(still.status).toBe("active");
    expect((await contextFor(o.ownerId, o.orgId)).roleKey).toBe("owner");
  });

  it("lets an owner change another owner, but never leaves the office without an active one", async () => {
    const o = await makeOffice();
    const secondId = await addMember(o.ctx, { email: "second@owners.test", name: "Second", roleKey: "owner", password: PASSWORD });
    await setMemberRole(o.ctx, secondId, "chief_of_staff");
    await setMemberRole(o.ctx, secondId, "owner");
    await setMemberStatus(o.ctx, secondId, "disabled");
    await expect(addMember(o.ctx, { email: await emailOf(o.ownerId), name: "Owner", roleKey: "chief_of_staff" })).rejects.toThrow(/at least one active owner/);
    expect((await contextFor(o.ownerId, o.orgId)).roleKey).toBe("owner");
  });

  it("still re-adds someone already on this office's staff", async () => {
    const o = await makeOffice();
    const aideId = await addMember(o.ctx, { email: "aide@owners.test", name: "Aide", roleKey: "legislative_aide", password: PASSWORD });
    await setMemberStatus(o.ctx, aideId, "disabled");
    expect(await addMember(o.ctx, { email: "aide@owners.test", name: "Aide", roleKey: "caseworker" })).toBe(aideId);
    expect((await contextFor(aideId, o.orgId)).roleKey).toBe("caseworker");
  });
});

describe("one office cannot sign up another's staff", () => {
  it("refuses an account that already works for another office, unless a script says so", async () => {
    const a = await makeOffice();
    const b = await makeOffice();
    const bEmail = await emailOf(b.ownerId);
    await expect(addMember(a.ctx, { email: bEmail, name: "Someone", roleKey: "legislative_aide" })).rejects.toThrow(/another office/);
    const offices = await (await systemDb()).select({ orgId: memberships.organizationId }).from(memberships).where(eq(memberships.userId, b.ownerId));
    expect(offices.map((m) => m.orgId)).toEqual([b.orgId]);
    expect(await addMember(a.ctx, { email: bEmail, name: "Someone", roleKey: "legislative_aide" }, { otherOffices: true })).toBe(b.ownerId);
  });
});

describe("two-step setup", () => {
  it("cannot replace a factor that is already on", async () => {
    const o = await makeOffice();
    const first = await beginMfaEnrollment(o.ownerId);
    const second = await beginMfaEnrollment(o.ownerId);
    await confirmMfaEnrollment(o.ownerId, first.secretEnc, totpAt(first.secret, Date.now()));
    await expect(beginMfaEnrollment(o.ownerId)).rejects.toThrow(/already on/);
    await expect(confirmMfaEnrollment(o.ownerId, second.secretEnc, totpAt(second.secret, Date.now()))).rejects.toThrow(/already on/);
    const [row] = await (await systemDb()).select({ secret: users.mfaSecretEnc }).from(users).where(eq(users.id, o.ownerId));
    expect(row.secret).toBe(first.secretEnc);
  });

  it("waits until a password someone else chose has been replaced", async () => {
    const o = await makeOffice();
    const aideId = await addMember(o.ctx, { email: "aide@enroll.test", name: "Aide", roleKey: "legislative_aide", password: TEMPORARY });
    await expect(beginMfaEnrollment(aideId)).rejects.toThrow(/your own password/);
    await changePassword(aideId, TEMPORARY, OWN, {});
    await expect(beginMfaEnrollment(aideId)).resolves.toHaveProperty("secret");
  });
});

describe("the code step", () => {
  async function pendingSignIn() {
    const o = await makeOffice();
    const { secret, secretEnc } = await beginMfaEnrollment(o.ownerId);
    await confirmMfaEnrollment(o.ownerId, secretEnc, totpAt(secret, Date.now()));
    const email = await emailOf(o.ownerId);
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const login = async () => (await loginWithPassword(email, PASSWORD, { ip })).token;
    return { ...o, secret, email, login, code: () => totpAt(secret, Date.now()) };
  }
  const setSession = async (token: string, values: Partial<typeof sessions.$inferInsert>) =>
    (await systemDb()).update(sessions).set(values).where(eq(sessions.tokenHash, sha256(token)));

  it("refuses a revoked, expired or idle sign-in, or a disabled account, like every other page", async () => {
    const p = await pendingSignIn();
    const revoked = await p.login();
    await revokeSession(revoked);
    await expect(completeMfa(revoked, p.code(), {})).rejects.toThrow(/Sign in again/);
    const expired = await p.login();
    await setSession(expired, { expiresAt: new Date(Date.now() - 1000) });
    await expect(completeMfa(expired, p.code(), {})).rejects.toThrow(/Sign in again/);
    const idle = await p.login();
    await setSession(idle, { lastSeenAt: new Date(Date.now() - SESSION_IDLE_MS - 60_000) });
    await expect(completeMfa(idle, p.code(), {})).rejects.toThrow(/Sign in again/);
    const disabled = await p.login();
    await (await systemDb()).update(users).set({ disabledAt: new Date() }).where(eq(users.id, p.ownerId));
    await expect(completeMfa(disabled, p.code(), {})).rejects.toThrow(/Sign in again/);
    await (await systemDb()).update(users).set({ disabledAt: null }).where(eq(users.id, p.ownerId));
    // The code still opens a live sign-in, so the refusals were about the session.
    expect(await completeMfa(await p.login(), p.code(), {})).toBeTruthy();
  });

  it("accepts each code once", async () => {
    const p = await pendingSignIn();
    const code = p.code();
    expect(await completeMfa(await p.login(), code, {})).toBeTruthy();
    await expect(completeMfa(await p.login(), code, {})).rejects.toThrow(/already used/);
  });
});

describe("sign-in limits", () => {
  it("stops guessing from one address without locking the person out everywhere", async () => {
    const o = await makeOffice();
    const email = await emailOf(o.ownerId);
    const attacker = { ip: "203.0.113.50" };
    for (let i = 0; i < 10; i++) await expect(loginWithPassword(email, "wrong password!!", attacker)).rejects.toThrow(/incorrect/);
    await expect(loginWithPassword(email, PASSWORD, attacker)).rejects.toThrow(/Too many/);
    expect((await loginWithPassword(email, PASSWORD, { ip: "198.51.100.200" })).token).toBeTruthy();
  });

  it("caps an account at 100 tries in 15 minutes across every address", async () => {
    const o = await makeOffice();
    const email = await emailOf(o.ownerId);
    for (let i = 0; i < 99; i++) await hitRateLimit(`login:acct:${sha256(email)}`, 100, 900);
    expect((await loginWithPassword(email, PASSWORD, { ip: "192.0.2.76" })).token).toBeTruthy();
    await expect(loginWithPassword(email, PASSWORD, { ip: "192.0.2.77" })).rejects.toThrow(/Too many/);
  });
});
