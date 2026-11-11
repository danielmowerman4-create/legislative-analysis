import { getEnv } from "../../env";
import { checked, CursorExpiredError, ProviderHttpError, providerFetch, requestTokens, type TokenSet } from "./http";
import type { MailEnvelope } from "./imap";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_SCOPES = {
  read: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
  send: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
};

const READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];
const SEND_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://mail.google.com/"];
export const gmailGrantsRead = (scopes: string[]) => scopes.some((s) => READ_SCOPES.includes(s));
export const gmailGrantsSend = (scopes: string[]) => scopes.some((s) => SEND_SCOPES.includes(s));

export function googleAuthUrl(state: string, codeChallenge: string, scopes: string[], loginHint?: string) {
  const env = getEnv();
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${env.APP_URL}/api/integrations/google/callback`,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${GOOGLE_AUTH_URL}?${p}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const env = getEnv();
  return requestTokens(GOOGLE_TOKEN_URL, "Google token", { client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...body });
}

export const googleExchangeCode = (code: string, verifier: string) =>
  tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${getEnv().APP_URL}/api/integrations/google/callback` });
export const googleRefresh = (refreshToken: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

type HistoryPage = { history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; nextPageToken?: string; historyId: string };

export class GmailClient {
  constructor(private readonly token: () => Promise<string>) {}

  private async get<T>(path: string, context: string): Promise<T> {
    const res = await providerFetch(`${API}${path}`, { headers: { authorization: `Bearer ${await this.token()}` } });
    return (await (await checked(res, context)).json()) as T;
  }

  private async post<T>(path: string, context: string, body: unknown): Promise<T> {
    const headers = { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" };
    const res = await providerFetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return (await (await checked(res, context)).json()) as T;
  }

  getProfile() {
    return this.get<{ emailAddress: string; historyId: string }>("/profile", "Gmail profile");
  }

  async listLabels() {
    const r = await this.get<{ labels: { id: string; name: string; type: string }[] }>("/labels", "Gmail labels");
    return r.labels;
  }

  listMessages(opts: { labelId: string; after: Date; before?: Date; pageToken?: string | null; maxResults?: number }) {
    const secs = (d: Date) => Math.floor(d.getTime() / 1000);
    const q = [`after:${secs(opts.after)}`, opts.before ? `before:${secs(opts.before)}` : null].filter(Boolean).join(" ");
    const p = new URLSearchParams({ q, labelIds: opts.labelId, maxResults: String(opts.maxResults ?? 200) });
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    return this.get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(`/messages?${p}`, "Gmail list");
  }

  async getRaw(id: string) {
    type Raw = { id: string; threadId: string; labelIds?: string[]; internalDate: string; raw: string };
    const m = await this.get<Raw>(`/messages/${encodeURIComponent(id)}?format=raw`, "Gmail get");
    const receivedAt = new Date(Number(m.internalDate));
    return { id: m.id, threadId: m.threadId, labels: m.labelIds ?? [], receivedAt, raw: Buffer.from(m.raw, "base64url") };
  }

  async getEnvelope(id: string): Promise<MailEnvelope> {
    const p = new URLSearchParams({ format: "metadata" });
    for (const h of ["To", "Subject", "Message-ID", "In-Reply-To", "References", "Date"]) p.append("metadataHeaders", h);
    type Metadata = { threadId: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
    const m = await this.get<Metadata>(`/messages/${encodeURIComponent(id)}?${p}`, "Gmail envelope");
    const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
    const ids = (v: string) => v.split(/\s+/).map((x) => x.replace(/^<|>$/g, "")).filter(Boolean);
    return {
      rfcMessageId: ids(header("message-id"))[0] ?? null,
      inReplyTo: ids(header("in-reply-to"))[0] ?? null,
      references: ids(header("references")),
      subject: header("subject"),
      to: [...header("to").matchAll(/[^\s<>,"]+@[^\s<>,"]+/g)].map((x) => x[0].toLowerCase()),
      sentAt: m.internalDate ? new Date(Number(m.internalDate)) : null,
      threadId: m.threadId ?? null,
    };
  }

  async sendRaw(raw: Uint8Array, threadId?: string | null) {
    const body = { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) };
    return this.post<{ id: string; threadId: string }>("/messages/send", "Gmail send", body);
  }

  async historySince(startHistoryId: string) {
    const added: { id: string; labels: string[] }[] = [];
    let pageToken: string | undefined;
    let latest = startHistoryId;
    do {
      const p = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "500" });
      if (pageToken) p.set("pageToken", pageToken);
      try {
        const r = await this.get<HistoryPage>(`/history?${p}`, "Gmail history");
        for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) added.push({ id: a.message.id, labels: a.message.labelIds ?? [] });
        latest = r.historyId ?? latest;
        pageToken = r.nextPageToken;
      } catch (e) {
        if (e instanceof ProviderHttpError && e.status === 404) throw new CursorExpiredError("Gmail history cursor expired");
        throw e;
      }
    } while (pageToken);
    const seen = new Set<string>();
    return { added: added.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true))), historyId: latest };
  }

  async watch(topicName: string, labelIds: string[]) {
    const body = { topicName, labelIds, labelFilterBehavior: "include" };
    const j = await this.post<{ historyId: string; expiration: string }>("/watch", "Gmail watch", body);
    return { historyId: j.historyId, expiresAt: new Date(Number(j.expiration)) };
  }
}
