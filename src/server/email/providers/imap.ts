import { lookup, resolveCname, resolveMx, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { ImapFlow } from "imapflow";
import type { AppPasswordShape } from "@/lib/app-password";

export type ImapSettings = { host: string; user: string; password: string };
export type FolderSnapshot = { uidValidity: string; uidNext: number; uids: number[] };
export type ImapMessage = { raw: Uint8Array; receivedAt: Date; threadId: string | null };
export type MailEnvelope = {
  rfcMessageId: string | null; inReplyTo: string | null; references: string[]; subject: string; to: string[]; sentAt: Date | null; threadId: string | null;
};

export interface ImapSession {
  listFolders(): Promise<{ path: string; isInbox: boolean; isSent?: boolean }[]>;
  search(folder: string, range: { since: Date; before?: Date }): Promise<FolderSnapshot>;
  newerThan(folder: string, uid: number): Promise<FolderSnapshot>;
  fetch(folder: string, uidValidity: string, uid: number): Promise<ImapMessage | null>;
  envelope(folder: string, uidValidity: string, uid: number): Promise<MailEnvelope | null>;
  close(): Promise<void>;
}

export type MailService = {
  kind: "google" | "microsoft" | "password";
  label: string;
  hosts: string[];
  smtp: { host: string; port: 465 | 587 }[];
  appPasswordUrl: string | null;
  appPassword: AppPasswordShape | null;
  twoStepUrl: string | null;
};

const tls = (host: string) => [{ host, port: 465 as const }];
const service = (label: string, host: string, smtp: MailService["smtp"], more: Partial<MailService> = {}): MailService => ({
  kind: "password", label, hosts: [host], smtp, appPasswordUrl: null, appPassword: null, twoStepUrl: null, ...more,
});
const GMAIL = service("Gmail", "imap.gmail.com", tls("smtp.gmail.com"), {
  kind: "google", appPasswordUrl: "https://myaccount.google.com/apppasswords", appPassword: "letters16",
  twoStepUrl: "https://myaccount.google.com/signinoptions/twosv",
});
const MICROSOFT: MailService = { kind: "microsoft", label: "Outlook", hosts: [], smtp: [], appPasswordUrl: null, appPassword: null, twoStepUrl: null };
const YAHOO = service("Yahoo", "imap.mail.yahoo.com", tls("smtp.mail.yahoo.com"), {
  appPasswordUrl: "https://login.yahoo.com/account/security", appPassword: "letters16",
});
const AOL = service("AOL", "imap.aol.com", tls("smtp.aol.com"), { appPasswordUrl: "https://login.aol.com/account/security", appPassword: "letters16" });
const ICLOUD = service("iCloud", "imap.mail.me.com", [{ host: "smtp.mail.me.com", port: 587 }], {
  appPasswordUrl: "https://account.apple.com/account/manage", appPassword: "apple",
});

const BY_ADDRESS: Record<string, MailService> = {
  "gmail.com": GMAIL,
  "googlemail.com": GMAIL,
  "outlook.com": MICROSOFT,
  "hotmail.com": MICROSOFT,
  "live.com": MICROSOFT,
  "msn.com": MICROSOFT,
  "yahoo.com": YAHOO,
  "ymail.com": YAHOO,
  "rocketmail.com": YAHOO,
  "aol.com": AOL,
  "icloud.com": ICLOUD,
  "me.com": ICLOUD,
  "mac.com": ICLOUD,
  "comcast.net": service("Xfinity", "imap.comcast.net", [{ host: "smtp.comcast.net", port: 587 }]),
  "att.net": service("AT&T", "imap.mail.att.net", tls("smtp.mail.att.net")),
  "fastmail.com": service("Fastmail", "imap.fastmail.com", tls("smtp.fastmail.com")),
  "zoho.com": service("Zoho", "imap.zoho.com", tls("smtp.zoho.com")),
};

const BY_MAIL_RECORD: [RegExp, MailService][] = [
  [/(^|\.)(google|googlemail)\.com$/, GMAIL],
  [/(^|\.)outlook\.com$/, MICROSOFT],
  [/yahoodns\.net$/, YAHOO],
  [/(^|\.)icloud\.com$/, ICLOUD],
  [/(^|\.)secureserver\.net$/, service("GoDaddy", "imap.secureserver.net", tls("smtpout.secureserver.net"))],
  [/(^|\.)zoho\.(com|eu)$/, service("Zoho", "imap.zoho.com", tls("smtp.zoho.com"))],
  [/(^|\.)messagingengine\.com$/, service("Fastmail", "imap.fastmail.com", tls("smtp.fastmail.com"))],
  [/(^|\.)emailsrvr\.com$/, service("Rackspace", "secure.emailsrvr.com", tls("secure.emailsrvr.com"))],
];

export type MailRecords = {
  mx(domain: string): Promise<string[]>;
  txt(domain: string): Promise<string[]>;
  cname(host: string): Promise<string[]>;
  microsoftDirectory(domain: string): Promise<boolean>;
};

const lookedUp: MailRecords = {
  mx: async (domain) => (await resolveMx(domain).catch(() => [])).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase()),
  txt: async (domain) => (await resolveTxt(domain).catch(() => [])).map((parts) => parts.join("").toLowerCase()),
  cname: async (host) => (await resolveCname(host).catch(() => [])).map((c) => c.toLowerCase()),
  microsoftDirectory: async (domain) => {
    try {
      const url = `https://login.microsoftonline.com/getuserrealm.srf?login=${encodeURIComponent(`user@${domain}`)}&json=1`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      const realm = (await res.json()) as { NameSpaceType?: string };
      return realm.NameSpaceType === "Managed" || realm.NameSpaceType === "Federated";
    } catch {
      return false;
    }
  },
};

const recordsHook = globalThis as { __mailRecordsForTests?: MailRecords | null };

export function setMailRecordsForTests(records: MailRecords | null) {
  recordsHook.__mailRecordsForTests = records;
}

export async function findMailService(email: string): Promise<MailService> {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (BY_ADDRESS[domain]) return BY_ADDRESS[domain];
  const records = recordsHook.__mailRecordsForTests ?? lookedUp;
  for (const host of await records.mx(domain)) {
    const hit = BY_MAIL_RECORD.find(([re]) => re.test(host.replace(/\.$/, "")));
    if (hit) return hit[1];
  }
  // Mail filters such as Proofpoint hide the service in MX; check other records.
  const [txt, autodiscover] = await Promise.all([records.txt(domain), records.cname(`autodiscover.${domain}`)]);
  const microsoft = txt.some((t) => /onmicrosoft\.com|spf\.protection\.outlook\.com/.test(t)) || autodiscover.some((c) => /(^|\.)outlook\.com\.?$/.test(c));
  if (microsoft) return MICROSOFT;
  if (txt.some((t) => /include:_spf\.google\.com/.test(t))) return GMAIL;
  if (await records.microsoftDirectory(domain)) return MICROSOFT;
  const smtp = [...tls(`smtp.${domain}`), { host: `smtp.${domain}`, port: 587 as const }, ...tls(`mail.${domain}`)];
  return service(domain, `imap.${domain}`, smtp, { hosts: [`imap.${domain}`, `mail.${domain}`] });
}

// Private, loopback, shared, link-local, test, benchmark, multicast, reserved.
function isPrivateV4([a, b, c]: number[]) {
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

function ipv6Groups(ip: string) {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = `${s.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  if (tail === undefined) return groups(head);
  const h = groups(head);
  const t = groups(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

function isPrivateAddress(ip: string) {
  if (isIP(ip) === 4) return isPrivateV4(ip.split(".").map(Number));
  if (isIP(ip) !== 6) return true;
  const g = ipv6Groups(ip);
  const v4 = (at: number) => [g[at] >> 8, g[at] & 255, g[at + 1] >> 8, g[at + 1] & 255];
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // IPv4 in IPv6 (compatible, mapped, translated, NAT64, 6to4) is judged as IPv4.
  if (zeros(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return isPrivateV4(v4(6));
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPrivateV4(v4(6));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateV4(v4(6));
  if (g[0] === 0x2002) return isPrivateV4(v4(1));
  // Local NAT64, discard, Teredo, docs, ULA, link-local, site-local, multicast.
  return (
    (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) || (g[0] === 0x100 && zeros(1, 4)) || (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) ||
    (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || g[0] >= 0xff00
  );
}

// Resolve once and connect to the checked IP, so DNS rebinding cannot swap it.
export async function publicAddress(host: string) {
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} is not a public mail server.`);
  return addresses[0].address;
}

const bare = (id: string | undefined | null) => (id ? id.trim().replace(/^<|>$/g, "") || null : null);

function imapSessionOver(client: ImapFlow): ImapSession {
  const open = (folder: string) => client.mailboxOpen(folder, { readOnly: true });
  const snapshot = (m: { uidValidity: bigint; uidNext: number }, uids: number[] | false): FolderSnapshot => ({
    uidValidity: String(m.uidValidity), uidNext: Number(m.uidNext), uids: uids || [],
  });
  return {
    async listFolders() {
      const list = await client.list();
      return list
        .filter((f) => !f.flags.has("\\Noselect"))
        .map((f) => ({ path: f.path, isInbox: f.path.toUpperCase() === "INBOX" || f.specialUse === "\\Inbox", isSent: f.specialUse === "\\Sent" }));
    },
    async search(folder, { since, before }) {
      const m = await open(folder);
      return snapshot(m, await client.search(before ? { since, before } : { since }, { uid: true }));
    },
    async newerThan(folder, uid) {
      const m = await open(folder);
      // A UID range ending in * always returns the newest message, even an older one.
      const found = await client.search({ uid: `${uid + 1}:*` }, { uid: true });
      return snapshot(m, found ? found.filter((u) => u > uid) : false);
    },
    async fetch(folder, uidValidity, uid) {
      const m = await open(folder);
      if (String(m.uidValidity) !== uidValidity) return null;
      const message = await client.fetchOne(String(uid), { source: true, internalDate: true, threadId: true }, { uid: true });
      if (!message || !message.source) return null;
      return { raw: new Uint8Array(message.source), receivedAt: new Date(message.internalDate ?? Date.now()), threadId: message.threadId ?? null };
    },
    async envelope(folder, uidValidity, uid) {
      const m = await open(folder);
      if (String(m.uidValidity) !== uidValidity) return null;
      const message = await client.fetchOne(String(uid), { envelope: true, threadId: true, headers: ["references"] }, { uid: true });
      if (!message || !message.envelope) return null;
      const e = message.envelope;
      const references = (message.headers?.toString("utf8") ?? "")
        .replace(/^references:/i, "")
        .split(/\s+/)
        .map(bare)
        .filter((x): x is string => Boolean(x));
      const to = (e.to ?? []).map((a) => a.address?.toLowerCase()).filter((x): x is string => Boolean(x));
      return {
        rfcMessageId: bare(e.messageId), inReplyTo: bare(e.inReplyTo), references, subject: e.subject ?? "", to, sentAt: e.date ?? null,
        threadId: message.threadId ?? null,
      };
    },
    async close() {
      await client.logout().catch(() => client.close());
    },
  };
}

async function openReal(settings: ImapSettings): Promise<ImapSession> {
  const client = new ImapFlow({
    host: await publicAddress(settings.host),
    // TLS still verifies the certificate against the host name.
    servername: settings.host,
    port: 993,
    secure: true,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
    disableAutoIdle: true,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 90_000,
  });
  client.on("error", () => undefined);
  await client.connect();
  return imapSessionOver(client);
}

type Opener = (settings: ImapSettings) => Promise<ImapSession>;
const hook = globalThis as { __imapOpenerForTests?: Opener | null };

export function setImapOpenerForTests(opener: Opener | null) {
  hook.__imapOpenerForTests = opener;
}

export const openImap: Opener = (settings) => (hook.__imapOpenerForTests ?? openReal)(settings);

export const isImapLoginRefused = (e: unknown) => Boolean((e as { authenticationFailed?: boolean } | null)?.authenticationFailed);

export const imapMessageId = (folder: string, uidValidity: string, uid: number) => `${uidValidity}:${uid}:${folder}`;

export function parseImapMessageId(id: string) {
  const [uidValidity, uid, ...folder] = id.split(":");
  return { uidValidity, uid: Number(uid), folder: folder.join(":") };
}
