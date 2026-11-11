import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { contextFor, freshDatabase, makeOffice } from "../helpers/db";
import { receive } from "../helpers/messages";
import { closeDb, withTenant } from "@/server/db/client";
import { emailConnections, emailMessages, emailSyncState, issueTaxonomy, mailLedger, messageIssueLinks, officeSettings } from "@/server/db/schema";
import { configureMailbox, connectPasswordMailbox, describeMailbox, listMailboxFolders } from "@/server/email/connections";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { findMailService, setImapOpenerForTests, type ImapSession } from "@/server/email/providers/imap";
import { CensusLookup, districtLookupFor, setDistrictLookupForTests } from "@/server/district/lookup";
import { enqueue } from "@/server/jobs/queue";
import { drainJobs } from "@/server/jobs/runner";
import { setIssueLabel } from "@/server/services/corrections";
import { listIssueOptions } from "@/server/services/inbox";
import { addMember } from "@/server/services/offices";
import { centerEnabled } from "@/server/services/center";
import { agenciesForEditing, issueListForEditing, saveAgency, saveIssue, setAgencyActive, setAiDailyLimit, setIssueActive,
  setTaggingLevels } from "@/server/services/reading";

const AUTH = "mx.google.com; dkim=pass header.d=mail.test; spf=pass smtp.mailfrom=x@mail.test; dmarc=pass header.from=mail.test";
const mime = (from: string, subject: string, body: string, id: string) => new TextEncoder().encode(`Authentication-Results: ${AUTH}\r\nFrom: ${from}\r\nTo: rep@gmail.com\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${id}@mail.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);

class FakeMailbox {
  uidValidity = "7";
  password = "abcdefghijklmnop";
  logins: { host: string; user: string; password: string }[] = [];
  refuse = false;
  writes = 0;
  next = 1;
  mail = new Map<number, Uint8Array>();
  add(from: string, subject: string, body: string) {
    const uid = this.next++;
    this.mail.set(uid, mime(from, subject, body, `m${uid}`));
    return uid;
  }
  private look(uids: number[]) {
    return { uidValidity: this.uidValidity, uidNext: this.next, uids };
  }
  open = async (s: { host: string; user: string; password: string }): Promise<ImapSession> => {
    this.logins.push(s);
    if (this.refuse || s.password !== this.password) throw Object.assign(new Error("no"), { authenticationFailed: true });
    return {
      listFolders: async () => [{ path: "INBOX", isInbox: true }, { path: "Constituents", isInbox: false }, { path: "[Gmail]/Sent Mail", isInbox: false }],
      search: async (folder) => this.look(folder === "INBOX" ? [...this.mail.keys()] : []),
      newerThan: async (folder, uid) => this.look(folder === "INBOX" ? [...this.mail.keys()].filter((u) => u > uid) : []),
      fetch: async (_f, v, uid) => (v === this.uidValidity && this.mail.has(uid) ? { raw: this.mail.get(uid)!, receivedAt: new Date(), threadId: null } : null),
      envelope: async () => null,
      close: async () => undefined,
    };
  };
}

const CONNECT = { email: "Rep@Gmail.com", password: "abcd efgh ijkl mnop", acknowledged: true };
const settingsOf = async (orgId: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(officeSettings).where(eq(officeSettings.organizationId, orgId))))[0];
const connectionOf = async (orgId: string) =>
  (await withTenant({ orgId }, (tx) => tx.select().from(emailConnections).where(eq(emailConnections.organizationId, orgId))))[0];
const stored = (orgId: string) => withTenant({ orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.organizationId, orgId)));
const tagsOf = async (orgId: string, messageId: string) => (await withTenant({ orgId },
  (tx) => tx.select({ key: messageIssueLinks.issueKey }).from(messageIssueLinks).where(eq(messageIssueLinks.messageId, messageId)))).map((r) => r.key);
const allJobs = () => drainJobs(["mail", "classify"]);

beforeAll(async () => {
  await freshDatabase();
});
afterAll(() => closeDb());
afterEach(() => {
  setImapOpenerForTests(null);
  setProviderFetchForTests(null);
  setDistrictLookupForTests(undefined);
});

describe("every office starts with everything on", () => {
  it("has the portal, its issue list, AI and district lookup without any operator step", async () => {
    const o = await makeOffice();
    expect(await centerEnabled(o.orgId)).toBe(true);
    expect((await issueListForEditing(o.ctx)).length).toBeGreaterThan(50);
    expect(await settingsOf(o.orgId)).toMatchObject({ aiEnabled: true, addressLookupEnabled: true });
  });
});

describe("connecting an email from Settings", () => {
  it("says how each address connects", async () => {
    const o = await makeOffice();
    expect(await describeMailbox(o.ctx, "someone@gmail.com"))
      .toMatchObject({ label: "Gmail", signIn: null, password: true, appPasswordUrl: expect.stringContaining("apppasswords") });
    expect(await describeMailbox(o.ctx, "someone@yahoo.com")).toMatchObject({ label: "Yahoo", password: true });
    expect(await describeMailbox(o.ctx, "someone@outlook.com")).toMatchObject({ label: "Outlook", password: false });
    await expect(describeMailbox(o.ctx, "nonsense")).rejects.toThrow(/full email/);
    expect((await findMailService("a@icloud.com")).hosts).toEqual(["imap.mail.me.com"]);
  });

  it("connects with an app password, never stores it readable, and turns on two-step", async () => {
    const o = await makeOffice();
    const box = new FakeMailbox();
    setImapOpenerForTests(box.open);
    const r = await connectPasswordMailbox(o.ctx, CONNECT);
    expect(box.logins[0]).toEqual({ host: "imap.gmail.com", user: "rep@gmail.com", password: "abcdefghijklmnop" });
    const c = await connectionOf(o.orgId);
    expect(c).toMatchObject({ provider: "imap", emailAddress: "rep@gmail.com", status: "pending", authMode: "password" });
    expect(JSON.stringify(c)).not.toContain("abcdefghijklmnop");
    expect((await settingsOf(o.orgId)).requireMfa).toBe(true);
    expect(r.next).toBe(`/account/mfa?required=1&next=${encodeURIComponent(`/constituent-center/setup?mailbox=${c.id}`)}`);
  });

  it("explains a refused password, and needs the confirmation", async () => {
    const o = await makeOffice();
    const box = new FakeMailbox();
    box.refuse = true;
    setImapOpenerForTests(box.open);
    await expect(connectPasswordMailbox(o.ctx, CONNECT)).rejects.toThrow(/did not accept that/);
    await expect(connectPasswordMailbox(o.ctx, { ...CONNECT, acknowledged: false })).rejects.toThrow(/authorized/);
    await expect(connectPasswordMailbox(o.ctx, { ...CONNECT, email: "a@outlook.com" })).rejects.toThrow(/Connect Outlook/);
    expect(await connectionOf(o.orgId)).toBeUndefined();
    expect((await settingsOf(o.orgId)).requireMfa).toBe(false);
  });

  it("keeps someone who does not work the office's mail out", async () => {
    const o = await makeOffice();
    const viewer = await contextFor(await addMember(o.ctx, { email: "v@mail.test", name: "V", roleKey: "viewer", title: "Intern" }), o.orgId);
    setImapOpenerForTests(new FakeMailbox().open);
    await expect(connectPasswordMailbox(viewer, CONNECT)).rejects.toThrow();
    await expect(describeMailbox(viewer, "someone@gmail.com")).rejects.toThrow();
    expect(await connectionOf(o.orgId)).toBeUndefined();
  });

  it("reads the general inbox, picks up new mail once, and tags it", async () => {
    const o = await makeOffice();
    const box = new FakeMailbox();
    setImapOpenerForTests(box.open);
    box.add("Ann Lee <ann@mail.test>", "Teacher pay", "Please raise teacher pay in our county.");
    await connectPasswordMailbox(o.ctx, CONNECT);
    const c = await connectionOf(o.orgId);
    const folders = await listMailboxFolders(o.ctx, c.id);
    expect(folders.filter((f) => f.isInbox).map((f) => f.id)).toEqual(["INBOX"]);
    await configureMailbox(o.ctx, c.id, { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01" });
    await allJobs();
    const first = await stored(o.orgId);
    expect(first).toHaveLength(1);
    expect(first[0].senderTrust).toBe("verified");
    expect(await tagsOf(o.orgId, first[0].id)).toContain("education.teacher_pay");

    box.add("Ben Ray <ben@mail.test>", "Potholes", "The potholes on my road need repair.");
    await enqueue("mail.incremental", { connectionId: c.id }, { orgId: o.orgId, idempotencyKey: "poll-1" });
    await allJobs();
    await enqueue("mail.incremental", { connectionId: c.id }, { orgId: o.orgId, idempotencyKey: "poll-2" });
    await allJobs();
    expect(await stored(o.orgId)).toHaveLength(2);
    const ledger = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(mailLedger).where(eq(mailLedger.organizationId, o.orgId)));
    expect(ledger.map((l) => l.disposition)).toEqual(["filed", "filed"]);
  });

  it("recovers when the server renumbers the folder, without storing anything twice", async () => {
    const o = await makeOffice();
    const box = new FakeMailbox();
    setImapOpenerForTests(box.open);
    box.add("Ann Lee <ann@mail.test>", "One", "Please fix the potholes.");
    await connectPasswordMailbox(o.ctx, CONNECT);
    const c = await connectionOf(o.orgId);
    await configureMailbox(o.ctx, c.id, { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01" });
    await allJobs();
    box.uidValidity = "8";
    box.add("Ben Ray <ben@mail.test>", "Two", "Please fix the bridge.");
    await enqueue("mail.incremental", { connectionId: c.id }, { orgId: o.orgId, idempotencyKey: "poll-r" });
    await allJobs();
    expect((await stored(o.orgId)).map((m) => m.subject).sort()).toEqual(["One", "Two"]);
    const [state] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailSyncState).where(eq(emailSyncState.connectionId, c.id)));
    expect(state.cursor?.startsWith("8:")).toBe(true);
  });

  it("asks to reconnect when the password stops working", async () => {
    const o = await makeOffice();
    const box = new FakeMailbox();
    setImapOpenerForTests(box.open);
    await connectPasswordMailbox(o.ctx, { ...CONNECT, email: "stops@gmail.com" });
    const c = await connectionOf(o.orgId);
    await configureMailbox(o.ctx, c.id, { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01" });
    await allJobs();
    await new Promise((r) => setTimeout(r, 5));
    const other = new FakeMailbox();
    other.refuse = true;
    setImapOpenerForTests(other.open);
    const { withImap, getConnection } = await import("@/server/email/connections");
    await withImap(await getConnection(o.orgId, c.id), async () => { throw Object.assign(new Error("no"), { authenticationFailed: true }); })
      .catch(() => undefined);
    expect((await connectionOf(o.orgId)).status).toBe("reauth_required");
  });
});

describe("the issue list in Settings", () => {
  it("tags new mail with an issue the office added", async () => {
    const o = await makeOffice();
    const key = await saveIssue(o.ctx, { parentKey: "transportation", label: "Airport noise", keywords: ["airport noise", "flight path"] });
    expect(key).toBe("transportation.airport_noise");
    const r = await receive(o.orgId, { from: "a@mail.test", name: "Ann", body: "The flight path over our street has gotten worse this year." });
    await drainJobs(["classify"]);
    expect(await tagsOf(o.orgId, r.messageId)).toContain(key);
  });

  it("uses edited words on the next message", async () => {
    const o = await makeOffice();
    const key = "transportation.road_maintenance";
    await saveIssue(o.ctx, { key, label: "Roads", keywords: ["Elm Street bridge"] });
    const hit = await receive(o.orgId, { from: "b@mail.test", name: "Ben", body: "When will the Elm Street bridge reopen?" });
    const miss = await receive(o.orgId, { from: "c@mail.test", name: "Cy", body: "There are so many potholes near my home." });
    await drainJobs(["classify"]);
    expect(await tagsOf(o.orgId, hit.messageId)).toContain(key);
    expect(await tagsOf(o.orgId, miss.messageId)).not.toContain(key);
  });

  it("stops tagging an issue that is turned off, without touching mail already tagged", async () => {
    const o = await makeOffice();
    const key = "transportation.road_maintenance";
    const before = await receive(o.orgId, { from: "d@mail.test", name: "Di", body: "These potholes are ruining my car." });
    await drainJobs(["classify"]);
    expect(await tagsOf(o.orgId, before.messageId)).toContain(key);
    await setIssueActive(o.ctx, key, false);
    const after = await receive(o.orgId, { from: "e@mail.test", name: "Ed", body: "So many potholes on my road." });
    await drainJobs(["classify"]);
    expect(await tagsOf(o.orgId, after.messageId)).not.toContain(key);
    expect(await tagsOf(o.orgId, before.messageId)).toContain(key);
    expect((await listIssueOptions(o.ctx)).some((x) => x.key === key)).toBe(false);
    await expect(setIssueLabel(o.ctx, after.messageId, key, "confirm")).rejects.toThrow(/not in the office/);
  });

  it("takes an area's issues with it, and brings the area back with an issue", async () => {
    const o = await makeOffice();
    await setIssueActive(o.ctx, "transportation", false);
    const active = (key: string) => withTenant({ orgId: o.orgId }, (tx) => tx.select({ on: issueTaxonomy.isActive }).from(issueTaxonomy)
      .where(and(eq(issueTaxonomy.organizationId, o.orgId), eq(issueTaxonomy.key, key)))).then((r) => r[0].on);
    expect(await active("transportation.road_maintenance")).toBe(false);
    await setIssueActive(o.ctx, "transportation.public_transit", true);
    expect(await active("transportation")).toBe(true);
    expect(await active("transportation.public_transit")).toBe(true);
  });

  it("refuses duplicates and nonsense, and aides cannot change the list", async () => {
    const o = await makeOffice();
    await expect(saveIssue(o.ctx, { parentKey: "transportation", label: "public transit", keywords: [] })).rejects.toThrow(/already/);
    await expect(saveIssue(o.ctx, { parentKey: "transportation", label: "X", keywords: [] })).rejects.toThrow(/name/);
    await expect(saveIssue(o.ctx, { parentKey: "nope", label: "New one", keywords: [] })).rejects.toThrow(/area/);
    await expect(saveIssue(o.ctx, { parentKey: "transportation", label: "New one", keywords: ["a"] })).rejects.toThrow(/between 2 and 80/);
    const aide = await contextFor(await addMember(o.ctx, { email: "a2@mail.test", name: "A", roleKey: "legislative_aide", title: "Aide" }), o.orgId);
    await expect(saveIssue(aide, { parentKey: "transportation", label: "New one", keywords: [] })).rejects.toThrow();
    await expect(setAiDailyLimit(aide, 10)).rejects.toThrow();
  });
});

describe("agencies and levels in Settings", () => {
  it("files mail from an agency the office added under Government", async () => {
    const o = await makeOffice();
    await saveAgency(o.ctx, { name: "Harbor Authority", abbreviation: "HA", domains: ["harbor.test", "@Port.Test"] });
    expect((await agenciesForEditing(o.ctx)).find((a) => a.name === "Harbor Authority")?.domains).toEqual(["harbor.test", "port.test"]);
    const r = await receive(o.orgId, { from: "clerk@harbor.test", name: "Clerk", body: "Attached is the quarterly report you requested from our staff." });
    await drainJobs(["classify"]);
    const [m] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.id, r.messageId)));
    expect(m.messageTypes[0]).toBe("government_agency");
  });

  it("refuses a public mail service, and can turn an agency off", async () => {
    const o = await makeOffice();
    await expect(saveAgency(o.ctx, { name: "Bad", domains: ["gmail.com"] })).rejects.toThrow(/public mail/);
    await expect(saveAgency(o.ctx, { name: "Bad", domains: ["not a domain"] })).rejects.toThrow(/not an email domain/);
    await saveAgency(o.ctx, { name: "Harbor Authority", domains: [] });
    const a = (await agenciesForEditing(o.ctx)).find((x) => x.name === "Harbor Authority")!;
    await setAgencyActive(o.ctx, a.id, false);
    expect((await agenciesForEditing(o.ctx)).find((x) => x.id === a.id)?.isActive).toBe(false);
  });

  it("uses the office's own tagging levels", async () => {
    const o = await makeOffice();
    await setTaggingLevels(o.ctx, { issue: 0.97, position: 0.9, billMatch: 0.95, messageType: 0.8 });
    const r = await receive(o.orgId, { from: "f@mail.test", name: "Fay", body: "Please look at teacher pay in our county." });
    await drainJobs(["classify"]);
    const [link] = await withTenant({ orgId: o.orgId }, (tx) =>
      tx.select().from(messageIssueLinks).where(and(eq(messageIssueLinks.messageId, r.messageId), eq(messageIssueLinks.issueKey, "education.teacher_pay"))));
    expect(link.status).toBe("needs_review");
    await expect(setTaggingLevels(o.ctx, { issue: 0.2, position: 0.9, billMatch: 0.95, messageType: 0.8 })).rejects.toThrow(/between 50 and 99/);
    await expect(setAiDailyLimit(o.ctx, -1)).rejects.toThrow(/whole number/);
    await setAiDailyLimit(o.ctx, 50);
    expect((await settingsOf(o.orgId)).aiDailyLimit).toBe(50);
  });
});

describe("district lookup with no key", () => {
  const reply = (geographies: object,
    city = "ATLANTA") => new Response(JSON.stringify({ result: { addressMatches: [{ addressComponents: { city }, geographies }] } }));
  it("reads both chambers from the Census Bureau, and is what a server with no key uses", async () => {
    setDistrictLookupForTests(undefined);
    expect((await districtLookupFor({ isDemo: false }))?.name).toBe("U.S. Census Bureau");
    const seen: string[] = [];
    setProviderFetchForTests(async (url) => {
      seen.push(url);
      return reply({ "2026 State Legislative Districts - Upper": [{ BASENAME: "36" }], "2026 State Legislative Districts - Lower": [{ BASENAME: "58" }] });
    });
    expect(await new CensusLookup().locate("206 Washington St SW, Atlanta, GA 30334"))
      .toEqual({ status: "matched", house: "58", senate: "36", city: "Atlanta" });
    expect(seen[0]).toContain("geocoding.geo.census.gov");
    expect(seen[0]).not.toMatch(/name|email/i);
  });
  it("says so when the address is not found", async () => {
    setProviderFetchForTests(async () => new Response(JSON.stringify({ result: { addressMatches: [] } })));
    expect(await new CensusLookup().locate("nowhere")).toEqual({ status: "not_found" });
  });
});
