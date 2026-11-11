import PostalMime from "postal-mime";
import type { Address, Mailbox } from "postal-mime";
import { sanitizeEmailHtml } from "./sanitize";
import { htmlToText } from "../classification/preprocess";

export type NormalizedAttachment = { filename: string; declaredType: string; sizeBytes: number; isInline: boolean; content: Uint8Array };

export type NormalizedMessage = {
  providerMessageId: string | null;
  providerThreadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  direction: "inbound" | "outbound";
  labels: string[];
  subject: string;
  from: { address: string; name: string | null };
  to: { address: string; name: string | null }[];
  cc: { address: string; name: string | null }[];
  replyTo: { address: string; name: string | null }[];
  sentAt: Date;
  receivedAt: Date;
  bodyText: string;
  bodyHtmlSanitized: string | null;
  headers: Record<string, string>;
  rawSizeBytes: number;
  attachments: NormalizedAttachment[];
};

const KEEP_HEADERS = new Set([
  "list-id",
  "list-unsubscribe",
  "precedence",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "x-spam-flag",
  "x-mailer",
  "return-path",
  "reply-to",
  "authentication-results",
  "received-spf",
  "dkim-signature",
  "x-ms-exchange-organization-authas",
  "x-original-from",
  "x-original-sender",
]);

const cleanId = (s: string | undefined | null) => (s ? s.trim().replace(/^<|>$/g, "") : null);

function flatten(list: Address[] | Address | undefined): { address: string; name: string | null }[] {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .flatMap((a) => (a.group ? a.group : [a]))
    .filter((m): m is Mailbox => Boolean(m.address))
    .map((m) => ({ address: m.address.toLowerCase(), name: m.name?.trim() || null }));
}

export async function normalizeRfc822(
  raw: Uint8Array | string,
  meta: { providerMessageId: string | null; providerThreadId: string | null; labels: string[]; receivedAt?: Date },
): Promise<NormalizedMessage> {
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer", maxPartCount: 500 });
  const headers: Record<string, string> = {};
  // Keep the topmost copy: the receiving server writes above any forged one.
  for (const h of parsed.headers) if (KEEP_HEADERS.has(h.key) && headers[h.key] === undefined) headers[h.key] = h.value.slice(0, 2000);

  const from = flatten(parsed.from)[0] ?? { address: "unknown@unknown", name: null };
  // Outbound only if filed as sent: anyone can put this mailbox in From.
  const outbound = meta.labels.includes("SENT");
  const sentAt = parsed.date ? new Date(parsed.date) : (meta.receivedAt ?? new Date());
  const html = parsed.html ? sanitizeEmailHtml(parsed.html) : null;
  const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : "";

  return {
    providerMessageId: meta.providerMessageId,
    providerThreadId: meta.providerThreadId,
    rfcMessageId: cleanId(parsed.messageId),
    inReplyTo: cleanId(parsed.inReplyTo),
    references: (parsed.references ?? "").split(/\s+/).map(cleanId).filter((x): x is string => Boolean(x)),
    direction: outbound ? "outbound" : "inbound",
    labels: meta.labels,
    subject: withoutExternalTag(parsed.subject ?? "").slice(0, 998),
    from,
    to: flatten(parsed.to),
    cc: flatten(parsed.cc),
    replyTo: flatten(parsed.replyTo),
    sentAt: isNaN(sentAt.getTime()) ? new Date() : sentAt,
    receivedAt: meta.receivedAt ?? (isNaN(sentAt.getTime()) ? new Date() : sentAt),
    bodyText: text.slice(0, 500_000),
    bodyHtmlSanitized: html ? html.slice(0, 1_000_000) : null,
    headers,
    rawSizeBytes: typeof raw === "string" ? Buffer.byteLength(raw) : raw.byteLength,
    attachments: parsed.attachments.map((a) => {
      const content =
        typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
      const isInline = a.disposition === "inline" || Boolean(a.related);
      return { filename: (a.filename ?? "attachment").slice(0, 255), declaredType: a.mimeType, sizeBytes: content.byteLength, isInline, content };
    }),
  };
}

export const withoutExternalTag = (s: string) =>
  s
    .replace(/\s*[\[(](?:external|ext)(?:\s+(?:e-?mail|sender|message|mail))?[\])]\s*:?\s*/gi, " ")
    .replace(/^\s*external(?:\s+e-?mail)?\s*:\s*/i, "")
    .trim();

export const normalizeSubject = (s: string) =>
  s
    .replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
