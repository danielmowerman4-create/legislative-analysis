import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { expectDbError, freshDatabase, makeOffice } from "../helpers/db";
import { systemDb, withTenant } from "@/server/db/client";
import { contacts, contactNotes, users } from "@/server/db/schema";
import { changePassword, loginWithPassword, loadSession, completeMfa, confirmMfaEnrollment, beginMfaEnrollment } from "@/server/auth/sessions";
import { totpAt } from "@/server/auth/totp";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { addMember } from "@/server/services/offices";

describe("foundation", () => {
  beforeAll(async () => {
    await freshDatabase();
  });

  it("enables RLS with a tenant policy on every table that has organization_id", async () => {
    const db = await systemDb();
    const res = await db.execute<{ table_name: string; rls: boolean; policies: number }>(sql`
      select c.table_name, cl.relrowsecurity as rls,
        (select count(*)::int from pg_policies p where p.tablename = c.table_name and p.policyname = 'tenant_isolation') as policies
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name
      join information_schema.tables t on t.table_name = c.table_name and t.table_schema = 'public' and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = 'organization_id'`);
    expect(res.rows.length).toBeGreaterThan(40);
    const missing = res.rows.filter((r) => !r.rls || r.policies < 1).map((r) => r.table_name);
    expect(missing).toEqual([]);
  });

  it("isolates tenants at the database level even without service-layer filters", async () => {
    const a = await makeOffice();
    const b = await makeOffice();
    await withTenant({ orgId: a.orgId }, (tx) => tx.insert(contacts).values({ organizationId: a.orgId, fullName: "Alice A" }));
    await withTenant({ orgId: b.orgId }, (tx) => tx.insert(contacts).values({ organizationId: b.orgId, fullName: "Bob B" }));

    // No WHERE clause on purpose: RLS must still scope the result.
    const seenByA = await withTenant({ orgId: a.orgId }, (tx) => tx.select({ name: contacts.fullName }).from(contacts));
    expect(seenByA.map((r) => r.name)).toEqual(["Alice A"]);

    await expectDbError(
      withTenant({ orgId: a.orgId }, (tx) => tx.insert(contacts).values({ organizationId: b.orgId, fullName: "Injected" })),
      /row-level security/,
    );
  });

  it("hides password hashes from the application role", async () => {
    const a = await makeOffice();
    await expectDbError(withTenant({ orgId: a.orgId }, (tx) => tx.select().from(users)), /permission denied/);
    const ok = await withTenant({ orgId: a.orgId }, (tx) => tx.select({ id: users.id, name: users.name }).from(users));
    expect(ok.length).toBeGreaterThan(0);
  });

  it("keeps private notes visible only to their author", async () => {
    const a = await makeOffice();
    const aideId = await addMember(a.ctx, { email: `aide-${a.orgId}@example.test`, name: "Aide", roleKey: "legislative_aide" });
    const [c] = await withTenant({ orgId: a.orgId }, (tx) =>
      tx.insert(contacts).values({ organizationId: a.orgId, fullName: "Carol C" }).returning({ id: contacts.id }),
    );
    await withTenant({ orgId: a.orgId, userId: a.ownerId }, (tx) =>
      tx.insert(contactNotes).values([
        { organizationId: a.orgId, contactId: c.id, authorId: a.ownerId, body: "office note", visibility: "office" },
        { organizationId: a.orgId, contactId: c.id, authorId: a.ownerId, body: "owner private", visibility: "private" },
      ]),
    );
    const aideSees = await withTenant({ orgId: a.orgId, userId: aideId }, (tx) =>
      tx.select({ body: contactNotes.body }).from(contactNotes).where(eq(contactNotes.contactId, c.id)),
    );
    expect(aideSees.map((n) => n.body)).toEqual(["office note"]);
  });

  it("logs in with password, enforces MFA when enabled, and builds permissions", async () => {
    const a = await makeOffice();
    const db = await systemDb();
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, a.ownerId));
    await expect(loginWithPassword(owner.email, "wrong password!!", {})).rejects.toThrow(/incorrect/);

    const { token, mfaPending } = await loginWithPassword(owner.email, "correct horse battery staple", {});
    expect(mfaPending).toBe(false);
    const s = await loadSession(token);
    expect(s?.ctx?.permissions.has("settings.manage")).toBe(true);

    const { secret, secretEnc } = await beginMfaEnrollment(a.ownerId);
    await confirmMfaEnrollment(a.ownerId, secretEnc, totpAt(secret, Date.now()));
    const second = await loginWithPassword(owner.email, "correct horse battery staple", {});
    expect(second.mfaPending).toBe(true);
    const pending = await loadSession(second.token);
    expect(pending?.ctx).toBeNull();
    await expect(completeMfa(second.token, "000000", {})).rejects.toThrow();
    const full = await completeMfa(second.token, totpAt(secret, Date.now()), {});
    expect((await loadSession(full))?.ctx?.orgId).toBe(a.orgId);
    expect(await loadSession(second.token)).toBeNull(); // pending token was rotated out
  });

  it("changes a password only with the current one, and the old one stops working", async () => {
    const a = await makeOffice();
    const db = await systemDb();
    const [owner] = await db.select({ email: users.email }).from(users).where(eq(users.id, a.ownerId));
    const current = "correct horse battery staple";
    const next = "a different long passphrase";
    await expect(changePassword(a.ownerId, "wrong password!!", next, {})).rejects.toThrow(/not correct/);
    await expect(changePassword(a.ownerId, current, "too short", {})).rejects.toThrow(/at least 12/);
    await expect(changePassword(a.ownerId, current, current, {})).rejects.toThrow(/different/);
    await changePassword(a.ownerId, current, next, {});
    await expect(loginWithPassword(owner.email, current, {})).rejects.toThrow(/incorrect/);
    expect((await loginWithPassword(owner.email, next, {})).mfaPending).toBe(false);
  });

  it("stops guessing at the current password after ten tries", async () => {
    const a = await makeOffice();
    for (let i = 0; i < 10; i++) await expect(changePassword(a.ownerId, "wrong password!!", "a different long passphrase", {})).rejects.toThrow(/not correct/);
    await expect(changePassword(a.ownerId, "correct horse battery staple", "a different long passphrase", {})).rejects.toThrow(/Too many/);
  });

  it("encrypts secrets with authenticated encryption", () => {
    const enc = encryptSecret("refresh-token-value");
    expect(enc).not.toContain("refresh-token-value");
    expect(decryptSecret(enc)).toBe("refresh-token-value");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
