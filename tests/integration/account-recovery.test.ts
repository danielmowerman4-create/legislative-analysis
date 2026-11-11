import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { closeDb, systemDb } from "@/server/db/client";
import { auditLogs, sessions, users } from "@/server/db/schema";
import { changePassword, confirmMfaEnrollment, beginMfaEnrollment, createSession, loadSession, loginWithPassword } from "@/server/auth/sessions";
import { totpAt } from "@/server/auth/totp";
import { addMember, resetMemberPassword, resetMemberTwoStep } from "@/server/services/offices";

const FIRST = "first temporary password";
const SECOND = "second temporary password";
const OWN = "a password only they know";
const meta = { ip: "203.0.113.9", userAgent: "test" };

let office: Awaited<ReturnType<typeof makeOffice>>;
let aideId: string;
const aideEmail = "aide@recovery.test";

beforeAll(async () => {
  await freshDatabase();
  office = await makeOffice();
  aideId = await addMember(office.ctx, { email: aideEmail, name: "Avery Aide", roleKey: "legislative_aide", password: FIRST });
});
afterAll(closeDb);

const openSessions = async (userId: string) =>
  (await (await systemDb()).select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))).length;

describe("getting a locked-out staff member back in", () => {
  it("makes a new staff member replace the password the owner chose for them", async () => {
    const { token } = await loginWithPassword(aideEmail, FIRST, meta);
    expect((await loadSession(token))?.passwordChangeRequired).toBe(true);
    await changePassword(aideId, FIRST, OWN, meta);
    expect((await loadSession(token))?.passwordChangeRequired).toBe(false);
    expect((await loadSession(await createSession(office.ownerId, { orgId: office.orgId, mfaVerified: true })))?.passwordChangeRequired).toBe(false);
  });

  it("lets the owner set a temporary password, which ends every sign-in and must be replaced", async () => {
    await loginWithPassword(aideEmail, OWN, meta);
    expect(await openSessions(aideId)).toBeGreaterThan(0);
    await resetMemberPassword(office.ctx, aideId, SECOND);
    expect(await openSessions(aideId)).toBe(0);
    await expect(loginWithPassword(aideEmail, OWN, meta)).rejects.toThrow(/incorrect/);
    const { token } = await loginWithPassword(aideEmail, SECOND, meta);
    expect((await loadSession(token))?.passwordChangeRequired).toBe(true);
    await changePassword(aideId, SECOND, OWN, meta);
    const db = await systemDb();
    const logged = await db.select({ action: auditLogs.action }).from(auditLogs)
      .where(and(eq(auditLogs.organizationId, office.orgId), eq(auditLogs.action, "member.password_reset")));
    expect(logged).toHaveLength(1);
  });

  it("lets the owner reset two-step for someone who lost their phone", async () => {
    const { secret, secretEnc } = await beginMfaEnrollment(aideId);
    await confirmMfaEnrollment(aideId, secretEnc, totpAt(secret, Date.now()));
    expect((await loginWithPassword(aideEmail, OWN, meta)).mfaPending).toBe(true);
    await resetMemberTwoStep(office.ctx, aideId);
    expect(await openSessions(aideId)).toBe(0);
    const again = await loginWithPassword(aideEmail, OWN, meta);
    expect(again.mfaPending).toBe(false);
    const [row] = await (await systemDb()).select({ secret: users.mfaSecretEnc, on: users.mfaEnabledAt }).from(users).where(eq(users.id, aideId));
    expect(row).toEqual({ secret: null, on: null });
  });

  it("refuses anyone who should not be resetting, and anyone who is not theirs to reset", async () => {
    const aide = await contextFor(aideId, office.orgId);
    const chiefId = await addMember(office.ctx, { email: "chief@recovery.test", name: "Casey Chief", roleKey: "chief_of_staff", password: FIRST });
    const chief = await contextFor(chiefId, office.orgId);
    await expect(resetMemberPassword(aide, chiefId, SECOND)).rejects.toThrow();
    await expect(resetMemberTwoStep(aide, chiefId)).rejects.toThrow();
    await expect(resetMemberPassword(office.ctx, office.ownerId, SECOND)).rejects.toThrow(/your own/);
    await expect(resetMemberPassword(chief, office.ownerId, SECOND)).rejects.toThrow(/owner/);
    await expect(resetMemberPassword(office.ctx, aideId, "too short")).rejects.toThrow(/at least 12/);
    const other = await makeOffice();
    await expect(resetMemberPassword(office.ctx, other.ownerId, SECOND)).rejects.toThrow(/not on this office/);
    // Someone on two offices' staff (script-only) is neither office's to reset.
    await addMember(other.ctx, { email: aideEmail, name: "Avery Aide", roleKey: "legislative_aide", password: "whatever the other office typed" },
      { otherOffices: true });
    await expect(resetMemberPassword(office.ctx, aideId, SECOND)).rejects.toThrow(/another office/);
    await expect(resetMemberTwoStep(office.ctx, aideId)).rejects.toThrow(/another office/);
    expect((await loginWithPassword(aideEmail, OWN, meta)).mfaPending).toBe(false);
  });
});

describe("a sign-in that is not finished opens nothing", () => {
  it("keeps the downloads and search shut until two-step is set up and a temporary password is replaced", async () => {
    const { officeGate } = await import("@/server/auth/gate");
    const base = { sessionId: "s", user: { id: "u", email: "e", name: "n", themePreference: "system" as const, mfaEnabled: false }, org: null, offices: [] };
    const ctx = office.ctx;
    expect(officeGate(null)).toBe("signed_out");
    expect(officeGate({ ...base, ctx: null, mfaVerified: false, mfaRequiredByOffice: false, passwordChangeRequired: false })).toBe("signed_out");
    expect(officeGate({ ...base, ctx, mfaVerified: true, mfaRequiredByOffice: true, passwordChangeRequired: false })).toBe("two_step_required");
    expect(officeGate({ ...base, ctx, mfaVerified: true, mfaRequiredByOffice: false, passwordChangeRequired: true })).toBe("password_required");
    expect(officeGate({ ...base, ctx, mfaVerified: true, mfaRequiredByOffice: false, passwordChangeRequired: false })).toBe("open");
  });
});
