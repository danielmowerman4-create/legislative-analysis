import { afterEach, describe, expect, it, vi } from "vitest";

const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>(), lookups: 0 }));
const made = vi.hoisted(() => ({ imap: [] as Record<string, unknown>[], smtp: [] as Record<string, unknown>[] }));
const google = vi.hoisted(() => ({ payload: { email: "anyone@attacker.iam.gserviceaccount.com", email_verified: true } as Record<string, unknown> }));

vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: async (host: string) => {
    dns.lookups++;
    return (dns.answers.get(host) ?? [host]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(options: Record<string, unknown>) {
      made.imap.push(options);
    }
    on() {}
    async connect() {}
  },
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      made.smtp.push(options);
      return { sendMail: async () => ({}), close: () => undefined };
    },
  },
}));
vi.mock("jose", () => ({ createRemoteJWKSet: () => null, jwtVerify: async () => ({ payload: google.payload }) }));

import { openImap, publicAddress } from "@/server/email/providers/imap";
import { sendSmtp } from "@/server/email/providers/smtp";
import { verifyPubsubToken } from "@/server/email/webhooks";
import { resetEnvForTests } from "@/server/env";

afterEach(() => {
  dns.answers.clear();
  dns.lookups = 0;
  made.imap.length = 0;
  made.smtp.length = 0;
  delete process.env.GOOGLE_PUBSUB_AUDIENCE;
  delete process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
  resetEnvForTests();
});

describe("mail server names from someone's address", () => {
  it("never lead to this machine or a private network, however the address is written", async () => {
    const inside = [
      "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.0.8", "198.18.0.1", "224.0.0.1",
      "::", "::1", "::127.0.0.1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:172.16.0.1", "::ffff:169.254.169.254", "::ffff:100.64.0.1", "::ffff:0:192.168.0.1",
      "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:a00:1::1", "2002:c0a8:101::", "fd00::1", "fc00::1", "fe80::1", "fec0::1", "ff02::1",
        "2001::1", "2001:db8::1", "100::1",
    ];
    for (const address of inside) await expect(publicAddress(address), address).rejects.toThrow(/not a public mail server/);
    dns.answers.set("imap.split.example", ["93.184.216.34", "10.0.0.5"]);
    await expect(publicAddress("imap.split.example")).rejects.toThrow(/not a public mail server/);
    for (const address of ["93.184.216.34", "2607:f8b0:4004:800::200e", "64:ff9b::5db8:d822",
      "2002:5db8:d822::1"]) expect(await publicAddress(address)).toBe(address);
  });

  it("connect to the address that was checked, and still check the certificate against the name", async () => {
    dns.answers.set("imap.example.org", ["93.184.216.34"]);
    await openImap({ host: "imap.example.org", user: "rep@example.org", password: "x" });
    expect(made.imap[0]).toMatchObject({ host: "93.184.216.34", servername: "imap.example.org", tls: { rejectUnauthorized: true } });
    expect(dns.lookups).toBe(1);

    dns.answers.set("smtp.example.org", ["93.184.216.34"]);
    await sendSmtp({ servers: [{ host: "smtp.example.org", port: 587 }], user: "rep@example.org", password: "x" },
      { from: "rep@example.org", to: "ann@mail.test", raw: new Uint8Array([65]) });
    expect(made.smtp[0])
      .toMatchObject({ host: "93.184.216.34", port: 587, requireTLS: true, tls: { rejectUnauthorized: true, servername: "smtp.example.org" } });

    dns.answers.set("imap.inside.example", ["10.0.0.5"]);
    await expect(openImap({ host: "imap.inside.example", user: "rep@inside.example", password: "x" })).rejects.toThrow(/not a public mail server/);
    expect(made.imap).toHaveLength(1);
  });
});

describe("Gmail push", () => {
  it("is believed only from the push account this deployment names", async () => {
    process.env.GOOGLE_PUBSUB_AUDIENCE = "https://app.example/api/webhooks/gmail";
    resetEnvForTests();
    // Any Google service account can sign a token for this audience.
    expect(await verifyPubsubToken("Bearer signed-by-google")).toBe(false);
    process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT = "push@office-app.iam.gserviceaccount.com";
    resetEnvForTests();
    expect(await verifyPubsubToken("Bearer signed-by-google")).toBe(false);
    google.payload = { email: "push@office-app.iam.gserviceaccount.com", email_verified: true };
    expect(await verifyPubsubToken("Bearer signed-by-google")).toBe(true);
  });
});
