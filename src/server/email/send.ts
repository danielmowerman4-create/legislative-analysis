import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import { AppError } from "../errors";
import { graphFor, imapSecret, tokenProvider, type Connection } from "./connections";
import { GmailClient, gmailGrantsSend } from "./providers/gmail";
import { graphGrantsSend } from "./providers/graph";
import { ProviderHttpError } from "./providers/http";
import { findMailService } from "./providers/imap";
import { isSmtpLoginRefused, sendSmtp } from "./providers/smtp";

export type OutgoingReply = {
  fromAddress: string;
  fromName: string | null;
  to: { address: string; name: string | null };
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
};

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const ADDRESS = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/;
const angle = (id: string) => `<${id.replace(/[<>\s]/g, "")}>`;

export const newMessageId = (mailbox: string) => `${randomUUID()}@${mailbox.split("@")[1] ?? "localhost"}`;

export async function buildReplyMime(m: OutgoingReply): Promise<Uint8Array> {
  if (!ADDRESS.test(m.to.address)) throw new AppError("validation", `${m.to.address} is not an address a reply can go to.`);
  const mail = new MailComposer({
    from: { name: oneLine(m.fromName ?? ""), address: m.fromAddress },
    to: { name: oneLine(m.to.name ?? ""), address: m.to.address },
    subject: oneLine(m.subject),
    text: m.text,
    messageId: angle(m.messageId),
    inReplyTo: m.inReplyTo ? angle(m.inReplyTo) : undefined,
    references: [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])].filter((r, i, all) => all.indexOf(r) === i).map(angle),
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return new Promise((resolve, reject) => mail.compile().build((err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf)))));
}

export function mailboxCanSend(conn: Pick<Connection, "provider" | "authMode" | "scopes" | "status">) {
  if (conn.status !== "active") return false;
  if (conn.provider === "imap" || conn.authMode === "application") return true;
  return conn.provider === "google" ? gmailGrantsSend(conn.scopes) : graphGrantsSend(conn.scopes);
}

export function sendFailure(e: unknown): string {
  const refused = isSmtpLoginRefused(e) || (e instanceof ProviderHttpError && (e.status === 401 || e.status === 403));
  if (refused) return "The mailbox refused. Turn sending on again in Settings.";
  if (e instanceof ProviderHttpError) return `The mail service would not take it (${e.code}).`;
  const code = (e as { code?: string } | null)?.code;
  if (["EPUBLIC", "ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET"].includes(code ?? "")) return "The mailbox's outgoing mail server could not be reached.";
  const smtp = (e as { responseCode?: number } | null)?.responseCode;
  return smtp ? `The mail service would not take it (${smtp}).` : "The reply could not be sent.";
}

export async function sendFromMailbox(
  conn: Connection,
  reply: OutgoingReply,
  opts: { providerThreadId?: string | null } = {},
): Promise<{ providerMessageId: string | null }> {
  const raw = await buildReplyMime(reply);
  if (conn.provider === "microsoft") {
    await graphFor(conn).sendMime(raw);
    return { providerMessageId: null };
  }
  if (conn.provider === "google") {
    const sent = await new GmailClient(tokenProvider(conn)).sendRaw(raw, opts.providerThreadId);
    return { providerMessageId: sent.id };
  }
  const { password } = imapSecret(conn);
  const service = await findMailService(conn.emailAddress);
  await sendSmtp({ servers: service.smtp, user: conn.emailAddress, password }, { from: conn.emailAddress, to: reply.to.address, raw });
  return { providerMessageId: null };
}
