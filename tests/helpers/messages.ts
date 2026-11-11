import type { NormalizedMessage } from "@/server/email/normalize";
import { ingestMessage } from "@/server/services/ingest";

let n = 0;

export async function receive(orgId: string, opts: { from: string; name?: string; subject?: string; body: string; at?: Date; headers?: Record<string, string>;
  auth?: string | null; replyTo?: { address: string; name?: string }; direction?: "inbound" | "outbound"; to?: string; inReplyTo?: string; rfcId?: string }) {
  n++;
  const at = opts.at ?? new Date();
  const domain = opts.from.toLowerCase().split("@")[1];
  // Every check passes unless a test says otherwise; `auth: null` omits it.
  const auth = opts.auth === undefined
    ? `mx.test; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${opts.from.toLowerCase()}; dmarc=pass header.from=${domain}` : opts.auth;
  const m: NormalizedMessage = {
    providerMessageId: null,
    providerThreadId: null,
    rfcMessageId: opts.rfcId ?? `test-${n}-${Math.random().toString(36).slice(2)}@example.test`,
    inReplyTo: opts.inReplyTo ?? null,
    references: opts.inReplyTo ? [opts.inReplyTo] : [],
    direction: opts.direction ?? "inbound",
    labels: [opts.direction === "outbound" ? "SENT" : "INBOX"],
    subject: opts.subject ?? "Message",
    from: { address: opts.from.toLowerCase(), name: opts.name ?? null },
    to: [{ address: (opts.to ?? "rep@house.example.gov").toLowerCase(), name: null }],
    cc: [],
    replyTo: opts.replyTo ? [{ address: opts.replyTo.address.toLowerCase(), name: opts.replyTo.name ?? null }] : [],
    sentAt: at,
    receivedAt: at,
    bodyText: opts.body,
    bodyHtmlSanitized: null,
    headers: { ...(auth ? { "authentication-results": auth } : {}), ...(opts.headers ?? {}) },
    rawSizeBytes: opts.body.length,
    attachments: [],
  };
  return ingestMessage(orgId, null, m);
}
