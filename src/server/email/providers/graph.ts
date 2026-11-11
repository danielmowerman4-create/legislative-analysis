import { getEnv } from "../../env";
import { checked, CursorExpiredError, ProviderHttpError, providerFetch, requestTokens, type TokenSet } from "./http";
import type { MailEnvelope } from "./imap";

const API = "https://graph.microsoft.com/v1.0";
const authority = (tenant?: string | null) => `https://login.microsoftonline.com/${tenant ?? getEnv().MICROSOFT_TENANT}/oauth2/v2.0`;

export const GRAPH_SCOPES = {
  read: ["offline_access", "openid", "email", "User.Read", "Mail.Read"],
  send: ["offline_access", "openid", "email", "User.Read", "Mail.Read", "Mail.Send"],
};

export const graphGrantsSend = (scopes: string[]) => scopes.some((s) => /(^|\/)Mail\.Send$/i.test(s));

// Graph caps mail subscriptions just under 7 days; renewal runs daily.
const GRAPH_SUBSCRIPTION_MINUTES = 6 * 24 * 60;
const subscriptionExpiry = () => new Date(Date.now() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();

// Without this, Graph message ids change when mail moves between folders.
const IMMUTABLE = 'IdType="ImmutableId"';

export function microsoftAuthUrl(state: string, codeChallenge: string, scopes: string[], loginHint?: string) {
  const env = getEnv();
  const p = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID!,
    response_type: "code",
    redirect_uri: `${env.APP_URL}/api/integrations/microsoft/callback`,
    response_mode: "query",
    scope: scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${authority()}/authorize?${p}`;
}

export function microsoftApprovalUrl() {
  const env = getEnv();
  const p = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID!,
    redirect_uri: `${env.APP_URL}/api/integrations/microsoft/callback`,
    // What linking asks for, so nobody is stopped again after admin approval.
    scope: ["openid", "email", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Read"].join(" "),
    state: APPROVAL_STATE,
  });
  return `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${p}`;
}

export const APPROVAL_STATE = "organization-approval";

async function tokenRequest(body: Record<string, string>, tenant?: string | null): Promise<TokenSet> {
  const env = getEnv();
  const client = { client_id: env.MICROSOFT_CLIENT_ID!, client_secret: env.MICROSOFT_CLIENT_SECRET! };
  return requestTokens(`${authority(tenant)}/token`, "Microsoft token", { ...client, ...body });
}

export const microsoftExchangeCode = (code: string, verifier: string, scopes: string[]) =>
  tokenRequest({
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: `${getEnv().APP_URL}/api/integrations/microsoft/callback`, scope: scopes.join(" "),
  });
export const microsoftRefresh = (refreshToken: string, scopes: string[]) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") });

// App-only token; the tenant admin scopes the grant to one mailbox.
export const microsoftAppToken = (tenantId: string) =>
  tokenRequest({ grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }, tenantId);

type MessageRef = { id: string; conversationId?: string; receivedDateTime?: string };
type Page<T> = { value: T[]; "@odata.nextLink"?: string };
type Envelope = {
  conversationId?: string; internetMessageId?: string; subject?: string; sentDateTime?: string; toRecipients?: { emailAddress?: { address?: string } }[];
};

export class GraphClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly mailbox: string | null = null,
  ) {}

  private get root() {
    return this.mailbox ? `/users/${encodeURIComponent(this.mailbox)}` : "/me";
  }

  private async req<T>(url: string, context: string, init: RequestInit = {}, prefer: string[] = []): Promise<T> {
    const res = await providerFetch(url.startsWith("http") ? url : `${API}${url}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.token()}`, "content-type": "application/json", prefer: [IMMUTABLE, ...prefer].join(", "), ...(init.headers ?? {}),
      },
    });
    return (await (await checked(res, context)).json()) as T;
  }

  me() {
    type Me = { mail: string | null; userPrincipalName: string; displayName: string };
    return this.req<Me>("/me?$select=mail,userPrincipalName,displayName", "Graph me");
  }

  async listFolders() {
    type Folder = { id: string; displayName: string; totalItemCount: number; childFolderCount?: number };
    const out: Folder[] = [];
    const queue = [{ path: `${this.root}/mailFolders?$top=100`, prefix: "" }];
    while (queue.length && out.length < 500) {
      const { path, prefix } = queue.shift()!;
      const r = await this.req<Page<Folder>>(path, "Graph folders");
      for (const f of r.value) {
        const displayName = `${prefix}${f.displayName}`;
        out.push({ ...f, displayName });
        const children = `${this.root}/mailFolders/${encodeURIComponent(f.id)}/childFolders?$top=100`;
        if (f.childFolderCount) queue.push({ path: children, prefix: `${displayName} / ` });
      }
      if (r["@odata.nextLink"]) queue.unshift({ path: r["@odata.nextLink"], prefix });
    }
    return out;
  }

  listMessages(folderId: string, opts: { after: Date; before?: Date; nextLink?: string | null }) {
    if (opts.nextLink) return this.req<Page<MessageRef>>(opts.nextLink, "Graph list");
    const filter = [`receivedDateTime ge ${opts.after.toISOString()}`, opts.before ? `receivedDateTime le ${opts.before.toISOString()}` : null]
      .filter(Boolean)
      .join(" and ");
    const p = new URLSearchParams({ $filter: filter, $select: "id,conversationId,receivedDateTime", $top: "100", $orderby: "receivedDateTime desc" });
    return this.req<Page<MessageRef>>(`${this.root}/mailFolders/${encodeURIComponent(folderId)}/messages?${p}`, "Graph list");
  }

  async getRaw(id: string) {
    const headers = { authorization: `Bearer ${await this.token()}`, prefer: IMMUTABLE };
    const res = await providerFetch(`${API}${this.root}/messages/${encodeURIComponent(id)}/$value`, { headers });
    const raw = new Uint8Array(await (await checked(res, "Graph MIME")).arrayBuffer());
    return { id, raw };
  }

  async getMeta(id: string) {
    type Meta = { id: string; conversationId: string; receivedDateTime: string; parentFolderId: string };
    return this.req<Meta>(`${this.root}/messages/${encodeURIComponent(id)}?$select=id,conversationId,receivedDateTime,parentFolderId`, "Graph meta");
  }

  sentFolder() {
    return this.req<{ id: string; displayName: string }>(`${this.root}/mailFolders/sentitems?$select=id,displayName`, "Graph sent folder");
  }

  async getEnvelope(id: string): Promise<MailEnvelope> {
    const m = await this.req<Envelope>(
      `${this.root}/messages/${encodeURIComponent(id)}?$select=conversationId,internetMessageId,subject,sentDateTime,toRecipients`,
      "Graph envelope",
    );
    return {
      rfcMessageId: m.internetMessageId?.replace(/^<|>$/g, "") ?? null,
      // Graph doesn't give these for sent mail; the conversation id threads it.
      inReplyTo: null,
      references: [],
      subject: m.subject ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address?.toLowerCase()).filter((x): x is string => Boolean(x)),
      sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
      threadId: m.conversationId ?? null,
    };
  }

  async sendMime(raw: Uint8Array) {
    const headers = { authorization: `Bearer ${await this.token()}`, "content-type": "text/plain" };
    const res = await providerFetch(`${API}${this.root}/sendMail`, { method: "POST", headers, body: Buffer.from(raw).toString("base64") });
    await checked(res, "Graph send");
  }

  async delta(folderId: string, deltaLink: string | null) {
    const changed: MessageRef[] = [];
    let url: string | null =
      deltaLink ?? `${this.root}/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=id,conversationId,receivedDateTime`;
    let next: string | null = null;
    try {
      while (url) {
        type DeltaPage = Page<MessageRef & { "@removed"?: unknown }> & { "@odata.deltaLink"?: string };
        const r: DeltaPage = await this.req(url, "Graph delta", {}, ["odata.maxpagesize=100"]);
        for (const v of r.value) if (!v["@removed"]) changed.push({ id: v.id, conversationId: v.conversationId, receivedDateTime: v.receivedDateTime });
        url = r["@odata.nextLink"] ?? null;
        next = r["@odata.deltaLink"] ?? next;
      }
    } catch (e) {
      const expired = e instanceof ProviderHttpError && (e.status === 410 || /syncStateNotFound|resyncRequired/i.test(e.code));
      if (expired) throw new CursorExpiredError("Graph delta token expired");
      throw e;
    }
    return { changed, deltaLink: next };
  }

  createSubscription(folderId: string, clientState: string) {
    const env = getEnv();
    return this.req<{ id: string; expirationDateTime: string }>("/subscriptions", "Graph subscribe", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: `${env.APP_URL}/api/webhooks/microsoft`,
        lifecycleNotificationUrl: `${env.APP_URL}/api/webhooks/microsoft`,
        resource: `${this.root.slice(1)}/mailFolders('${folderId}')/messages`,
        expirationDateTime: subscriptionExpiry(),
        clientState,
      }),
    });
  }

  renewSubscription(subscriptionId: string) {
    return this.req<{ id: string; expirationDateTime: string }>(`/subscriptions/${encodeURIComponent(subscriptionId)}`, "Graph renew", {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: subscriptionExpiry() }),
    });
  }
}
