import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { publicAddress, type MailService } from "./imap";

export type SmtpSettings = { servers: MailService["smtp"]; user: string; password: string };
export type OutgoingMail = { from: string; to: string; raw: Uint8Array };

export const isSmtpLoginRefused = (e: unknown) => {
  const err = e as { code?: string; responseCode?: number } | null;
  return err?.code === "EAUTH" || err?.responseCode === 535 || err?.responseCode === 534;
};

// Only errors before the server took the message, so a retry cannot send twice.
const NEVER_REACHED = ["ECONNECTION", "ETIMEDOUT", "EDNS", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EPUBLIC"];
const neverReached = (e: unknown) => NEVER_REACHED.includes((e as { code?: string } | null)?.code ?? "");

type Options = (server: MailService["smtp"][number]) => SMTPTransport.Options;
const hook = globalThis as { __smtpOptionsForTests?: Options | null };

export function setSmtpOptionsForTests(options: Options | null) {
  hook.__smtpOptionsForTests = options;
}

async function optionsFor(server: MailService["smtp"][number]): Promise<SMTPTransport.Options> {
  if (hook.__smtpOptionsForTests) return hook.__smtpOptionsForTests(server);
  // The host comes from someone's address, so it must resolve to a public IP.
  const address = await publicAddress(server.host).catch((e: Error) => {
    throw Object.assign(e, { code: "EPUBLIC" });
  });
  // Connect to the checked IP; TLS still verifies the certificate by host name.
  const tls = { minVersion: "TLSv1.2" as const, rejectUnauthorized: true, servername: server.host };
  return { host: address, port: server.port, secure: server.port === 465, requireTLS: true, tls };
}

export async function sendSmtp(settings: SmtpSettings, mail: OutgoingMail) {
  let last: unknown = Object.assign(new Error("No outgoing mail server was found for this mailbox."), { code: "ECONNECTION" });
  for (const server of settings.servers) {
    try {
      const transport = nodemailer.createTransport({
        ...(await optionsFor(server)),
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      try {
        await transport.sendMail({ envelope: { from: mail.from, to: [mail.to] }, raw: Buffer.from(mail.raw) });
        return { host: server.host };
      } finally {
        transport.close();
      }
    } catch (e) {
      last = e;
      if (!neverReached(e)) break;
    }
  }
  throw last;
}
