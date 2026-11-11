import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { freshDatabase, makeOffice } from "../helpers/db";
import { FakeImap } from "../helpers/fake-imap";
import { closeDb, systemDb, withTenant } from "@/server/db/client";
import { emailConnections, emailMessages, messageEvents, webhookDeliveries } from "@/server/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { AppError } from "@/server/errors";
import { completeMailboxConnection, configureMailbox, connectMicrosoftApplication, connectPasswordMailbox, linkErrorCode, linkErrorMessage,
  listMailboxFolders } from "@/server/email/connections";
import { normalizeRfc822 } from "@/server/email/normalize";
import { setProviderFetchForTests } from "@/server/email/providers/http";
import { setImapOpenerForTests, setMailRecordsForTests } from "@/server/email/providers/imap";
import { assessSender } from "@/server/email/sender-trust";
import { processGraphNotifications } from "@/server/email/webhooks";
import { resetEnvForTests } from "@/server/env";
import { drainJobs } from "@/server/jobs/runner";

beforeAll(async () => {
  await freshDatabase();
});
afterAll(() => closeDb());
afterEach(() => {
  setImapOpenerForTests(null);
  setMailRecordsForTests(null);
  setProviderFetchForTests(null);
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  resetEnvForTests();
});

const base = { from: { address: "pat.reed@house.ga.gov", name: "Pat Reed" }, replyTo: [], relayRules: [], internalDomains: ["house.ga.gov"] };
const passes = (server: string | null,
  domain = "house.ga.gov") => `${server ? `${server}; ` : ""}spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`;
const FAILS = "mx.google.com; spf=fail smtp.mailfrom=bulk.example; dkim=none; dmarc=fail header.from=house.ga.gov";
const AUTH_AS = { "x-ms-exchange-organization-authas": "Internal" };

describe("whose word on the sender counts", () => {
  it("believes Exchange's internal mark only on mail read from Microsoft", () => {
    // Gmail flagged the From; the sender added Exchange's header to talk past it.
    expect(assessSender({ ...base, headers: { "authentication-results": FAILS, ...AUTH_AS }, source: { provider: "google" } }).trust).toBe("failed");
    expect(assessSender({ ...base, headers: AUTH_AS, source: { provider: "imap", imapHost: "imap.house.ga.gov" } }).trust).toBe("unverified");
    expect(assessSender({ ...base, headers: AUTH_AS, source: { provider: "microsoft" } })).toMatchObject({ trust: "verified", isInternal: true });
  });

  it("reads Authentication-Results only from the mailbox's own service", () => {
    const trust = (results: string, source: Parameters<typeof assessSender>[0]["source"]) =>
      assessSender({ ...base, headers: { "authentication-results": results }, source }).trust;
    expect(trust(passes("mx.google.com"), { provider: "google" })).toBe("verified");
    expect(trust(passes("mx.test"), { provider: "google" })).toBe("unverified");
    expect(trust(passes(null), { provider: "google" })).toBe("unverified");
    expect(trust(passes(null), { provider: "microsoft" })).toBe("verified");
    expect(trust(passes("bn8nam11ft062.mail.protection.outlook.com"), { provider: "microsoft" })).toBe("verified");
    expect(trust(passes("mx.evil.example"), { provider: "microsoft" })).toBe("unverified");
    expect(trust(passes("mx.house.ga.gov"), { provider: "imap", imapHost: "imap.house.ga.gov" })).toBe("verified");
    expect(trust(passes("mx.evil.example"), { provider: "imap", imapHost: "imap.house.ga.gov" })).toBe("unverified");
    expect(trust(passes(null), { provider: "imap", imapHost: "imap.house.ga.gov" })).toBe("unverified");
    expect(trust(passes("mx.google.com"), { provider: "imap", imapHost: "imap.gmail.com" })).toBe("verified");
  });

  it("holds forged staff mail read in from an IMAP mailbox", async () => {
    const o = await makeOffice({ internalDomains: ["house.ga.gov"] });
    setMailRecordsForTests({ mx: async () => ["mx.office-mail.example"], txt: async () => [], cname: async () => [], microsoftDirectory: async () => false });
    const box = new FakeImap("rep.test@house.ga.gov");
    box.addRaw("INBOX", `X-MS-Exchange-Organization-AuthAs: Internal\r\nFrom: Pat Reed <pat.reed@house.ga.gov>\r\nTo: rep.test@house.ga.gov\r\nSubject: Gift cards\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <gift@evil.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBuy gift cards for the district office today.\r\n`);
    box.password = "office-app-password";
    setImapOpenerForTests(box.open);
    const linked = await connectPasswordMailbox(o.ctx, { email: box.address, password: box.password, acknowledged: true });
    await configureMailbox(o.ctx, linked.id, { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01" });
    await drainJobs(["mail"]);
    const [m] = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.rfcMessageId, "gift@evil.example")));
    expect(m).toMatchObject({ senderTrust: "unverified", isInternal: false, requiresReview: true });
  });
});

describe("what counts as sent by the office", () => {
  const raw = `From: rep@house.ga.gov\r\nTo: ann@mail.test\r\nSubject: Re: Potholes\r\nMessage-ID: <x@evil.example>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nDone.\r\n`;
  const meta = (labels: string[]) => ({ providerMessageId: "1", providerThreadId: null, labels, mailboxAddress: "rep@house.ga.gov",
    internalDomains: ["house.ga.gov"] });

  it("goes by the mail service's sent mark, not the From line", async () => {
    expect((await normalizeRfc822(raw, meta(["INBOX"]))).direction).toBe("inbound");
    expect((await normalizeRfc822(raw, meta(["SENT"]))).direction).toBe("outbound");
  });

  it("does not let mail in the office's name close a constituent's letter", async () => {
    const o = await makeOffice();
    setMailRecordsForTests({ mx: async () => ["mx.office-mail.example"], txt: async () => [], cname: async () => [], microsoftDirectory: async () => false });
    const box = new FakeImap("rep@house.example.gov");
    setImapOpenerForTests(box.open);
    const linked = await connectPasswordMailbox(o.ctx, { email: box.address, password: box.password, acknowledged: true });
    const sent = (await listMailboxFolders(o.ctx, linked.id)).find((f) => f.isSent)!;
    await configureMailbox(o.ctx, linked.id,
      { folders: [{ id: "INBOX", name: "INBOX" }], importFrom: "2026-01-01", sentFolder: { id: sent.id, name: sent.name } });
    box.add("INBOX", { from: "Ann Lee <ann@mail.test>", subject: "Potholes on Elm Street", body: "Please fix the potholes.", id: "ann-1@mail.test" });
    // Someone else writes as the office, "answering" Ann.
    box.add("INBOX", { from: "Rep. Test <rep@house.example.gov>", to: "ann@mail.test", subject: "Re: Potholes on Elm Street", body: "Handled.",
      id: "fake@evil.example", inReplyTo: "ann-1@mail.test" });
    await drainJobs(["mail"]);
    const stored = await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(emailMessages).where(eq(emailMessages.organizationId, o.orgId)));
    const ann = stored.find((m) => m.rfcMessageId === "ann-1@mail.test")!;
    expect(stored.find((m) => m.rfcMessageId === "fake@evil.example")?.direction).toBe("inbound");
    expect(ann.triageStatus).toBe("new");
    expect(await withTenant({ orgId: o.orgId }, (tx) => tx.select().from(messageEvents).where(eq(messageEvents.messageId, ann.id)))).toEqual([]);
  });
});

describe("unattended Outlook access", () => {
  const TENANT = "11111111-2222-3333-4444-555555555555";
  let calls: string[] = [];
  const microsoft = async (input: string) => {
    calls.push(input);
    if (input.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: "app-token", expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  };
  const linkDelegated = (orgId: string, userId: string, address: string) =>
    withTenant({ orgId }, (tx) => tx.insert(emailConnections).values({ organizationId: orgId, provider: "microsoft", emailAddress: address, status: "active",
      authMode: "delegated", scopes: ["Mail.Read"], authorizedBy: userId, authorizedAt: new Date() }));

  it("reaches only mailboxes on a domain the office signed in from, and never another office's", async () => {
    process.env.MICROSOFT_CLIENT_ID = "client";
    process.env.MICROSOFT_CLIENT_SECRET = "secret";
    resetEnvForTests();
    calls = [];
    setProviderFetchForTests(microsoft);
    const victim = await makeOffice();
    const attacker = await makeOffice();
    await linkDelegated(victim.orgId, victim.ownerId, "rep@senate.example.gov");
    await withTenant({ orgId: victim.orgId },
      (tx) => tx.insert(emailConnections).values({ organizationId: victim.orgId, provider: "microsoft", emailAddress: "office@senate.example.gov",
      status: "active", authMode: "application", tenantId: TENANT, scopes: ["Mail.Read"], authorizedBy: victim.ownerId, authorizedAt: new Date() }));

    await expect(connectMicrosoftApplication(attacker.ctx, { tenantId: TENANT, mailbox: "office@senate.example.gov", acknowledged: true }))
      .rejects.toThrow("First link your own Outlook account from senate.example.gov.");
    await linkDelegated(attacker.orgId, attacker.ownerId, "aide@senate.example.gov");
    await expect(connectMicrosoftApplication(attacker.ctx, { tenantId: TENANT, mailbox: "office@senate.example.gov", acknowledged: true }))
      .rejects.toThrow("Another office has already connected this mailbox.");
    expect(calls).toEqual([]);

    await connectMicrosoftApplication(attacker.ctx, { tenantId: TENANT, mailbox: "press@senate.example.gov", acknowledged: true });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("webhooks", () => {
  it("writes nothing for a Microsoft notification it cannot match", async () => {
    const db = await systemDb();
    const before = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.provider, "microsoft"));
    const r = await processGraphNotifications({ value: Array.from({ length: 5 }, (_, i) => ({ subscriptionId: `made-up-${i}`, clientState: "guess" })) });
    expect(r).toMatchObject({ enqueued: 0, rejected: 5 });
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.provider, "microsoft"))).toHaveLength(before.length);
  });
});

describe("secrets at rest", () => {
  it("refuses a shortened authentication tag", () => {
    const enc = encryptSecret("refresh-token-value");
    const [keyId, iv, tag, ct] = enc.split(".");
    // A truncated tag, which GCM accepts unless the full length is required.
    const short = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(() => decryptSecret([keyId, iv, short, ct].join("."))).toThrow();
    expect(decryptSecret(enc)).toBe("refresh-token-value");
  });
});

describe("why a mailbox was not linked", () => {
  it("shows only the app's own words, whatever the address says", async () => {
    expect(linkErrorMessage("expired")).toBe("This connection link expired. Start again from Settings.");
    expect(linkErrorMessage("Your mailbox was suspended. Call 555-0100 to restore it.")).toBe("The mailbox could not be connected.");
    expect(linkErrorMessage("constructor")).toBe("The mailbox could not be connected.");
    const o = await makeOffice();
    const e = await completeMailboxConnection("google", "code", "no-such-state", o.ownerId).catch((x) => x);
    expect(linkErrorCode(e)).toBe("expired");
    expect(linkErrorCode(new AppError("validation", "Anything at all."))).toBe("failed");
    expect(linkErrorCode(new Error("boom"))).toBe("failed");
  });
});
