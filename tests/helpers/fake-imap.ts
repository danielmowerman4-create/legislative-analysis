import type { ImapSession, MailEnvelope } from "@/server/email/providers/imap";

const STAMPED_BY: Record<string, string> = { "gmail.com": "mx.google.com", "yahoo.com": "atlas.mail.yahoo.com" };
const auth = (address: string) => `${STAMPED_BY[address.split("@")[1]] ?? `mx.${address.split("@")[1]}`}; dkim=pass header.d=mail.test; spf=pass smtp.mailfrom=x@mail.test; dmarc=pass header.from=mail.test`;

type Mail = { from: string; to?: string; subject: string; body: string; id?: string; inReplyTo?: string; date?: Date };

export class FakeImap {
  uidValidity = "7";
  password = "abcdefghijklmnop";
  refuse = false;
  sentName = "Sent";
  private next = 1;
  private folders = new Map<string, Map<number, { raw: Uint8Array; id: string }>>([["INBOX", new Map()], [this.sentName, new Map()]]);
  read: string[] = [];
  logins: { host: string; user: string; password: string }[] = [];

  constructor(readonly address = "rep@gmail.com") {}

  add(folder: "INBOX" | "Sent", m: Mail) {
    const uid = this.next++;
    const id = m.id ?? `m${uid}@mail.test`;
    const raw =
      (folder === "INBOX" ? `Authentication-Results: ${auth(this.address)}\r\n` : "") +
      `From: ${m.from}\r\nTo: ${m.to ?? this.address}\r\nSubject: ${m.subject}\r\nDate: ${(m.date ?? new Date()).toUTCString()}\r\nMessage-ID: <${id}>\r\n` +
      (m.inReplyTo ? `In-Reply-To: <${m.inReplyTo}>\r\nReferences: <${m.inReplyTo}>\r\n` : "") +
      `MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.body}\r\n`;
    this.folders.get(folder === "Sent" ? this.sentName : folder)!.set(uid, { raw: new TextEncoder().encode(raw), id });
    return id;
  }

  addRaw(folder: "INBOX" | "Sent", raw: string) {
    const uid = this.next++;
    const id = raw.match(/^Message-ID:\s*<([^>]+)>/im)?.[1] ?? `raw${uid}@mail.test`;
    this.folders.get(folder === "Sent" ? this.sentName : folder)!.set(uid, { raw: new TextEncoder().encode(raw), id });
    return id;
  }

  fileSent(raw: string) {
    const uid = this.next++;
    const id = raw.match(/^Message-ID:\s*<([^>]+)>/im)?.[1] ?? `sent${uid}@mail.test`;
    this.folders.get(this.sentName)!.set(uid, { raw: new TextEncoder().encode(raw), id });
    return id;
  }

  private look(folder: string, keep: (uid: number) => boolean) {
    return { uidValidity: this.uidValidity, uidNext: this.next, uids: [...(this.folders.get(folder)?.keys() ?? [])].filter(keep) };
  }

  open = async (s: { host: string; user: string; password: string }): Promise<ImapSession> => {
    this.logins.push(s);
    if (this.refuse || s.password !== this.password) throw Object.assign(new Error("no"), { authenticationFailed: true });
    return {
      listFolders: async () =>
        [{ path: "INBOX", isInbox: true }, { path: "Constituents", isInbox: false }, { path: this.sentName, isInbox: false, isSent: true }],
      search: async (folder) => this.look(folder, () => true),
      newerThan: async (folder, uid) => this.look(folder, (u) => u > uid),
      fetch: async (folder, v, uid) => {
        const m = this.folders.get(folder)?.get(uid);
        if (v !== this.uidValidity || !m) return null;
        this.read.push(`${folder}:${m.id}`);
        // Stands in for the server's arrival time.
        const dated = new Date(new TextDecoder().decode(m.raw).match(/^Date:\s*(.+)$/im)?.[1] ?? "");
        return { raw: m.raw, receivedAt: Number.isNaN(dated.getTime()) ? new Date() : dated, threadId: null };
      },
      envelope: async (folder, v, uid): Promise<MailEnvelope | null> => {
        const m = this.folders.get(folder)?.get(uid);
        if (v !== this.uidValidity || !m) return null;
        const head = new TextDecoder().decode(m.raw).split("\r\n\r\n")[0];
        const header = (name: string) => head.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
        const ids = (v2: string) => v2.split(/\s+/).map((x) => x.replace(/^<|>$/g, "")).filter(Boolean);
        return { rfcMessageId: ids(header("Message-ID"))[0] ?? null, inReplyTo: ids(header("In-Reply-To"))[0] ?? null, references: ids(header("References")),
          subject: header("Subject"), to: [...header("To").matchAll(/[^\s<>,"]+@[^\s<>,"]+/g)].map((x) => x[0].toLowerCase()), sentAt: new Date(header("Date")),
          threadId: null };
      },
      close: async () => undefined,
    };
  };
}
