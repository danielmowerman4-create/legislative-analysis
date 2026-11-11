import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { systemDb, withTenant } from "../db/client";
import { emailConnections, emailSyncState, integrationErrors, oauthStates, officeSettings, users } from "../db/schema";
import { decryptSecret, encryptSecret, randomToken } from "../crypto";
import { integrationsConfigured } from "../env";
import { AppError, forbidden } from "../errors";
import { enqueue, PermanentJobError } from "../jobs/queue";
import { can, requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { audit } from "../services/audit";
import { GMAIL_SCOPES, GmailClient, gmailGrantsRead, gmailGrantsSend, googleAuthUrl, googleExchangeCode, googleRefresh } from "./providers/gmail";
import { GRAPH_SCOPES, GraphClient, graphGrantsSend, microsoftAppToken, microsoftAuthUrl, microsoftExchangeCode, microsoftRefresh } from "./providers/graph";
import { ProviderHttpError, type TokenSet } from "./providers/http";
import { findMailService, isImapLoginRefused, openImap, type ImapSession, type MailService } from "./providers/imap";
import { appPasswordProblem, cleanAppPassword, type AppPasswordShape } from "@/lib/app-password";

export type Connection = typeof emailConnections.$inferSelect;

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AUTHORIZATION_STATEMENT =
  "I am authorized by this office to connect this mailbox. Connecting lets this app read it for constituent services and legislative work, and nothing else.";

// Only a code travels in the URL, so a crafted link cannot put words on the page.
const LINK_ERRORS: Record<string, string> = {
  denied: "Access was not granted.",
  denied_microsoft: "Microsoft did not give access. If it said your organization has to approve this app, send your IT administrator the approval link under Link your email.",
  auth_failed: "Authorization failed.",
  missing_code: "The sign-in did not finish. Start again from Settings.",
  expired: "This connection link expired. Start again from Settings.",
  other_user: "This connection was started by a different user.",
  no_read: "Google did not give permission to read your email. Press Connect Gmail again and tick the box to read your email.",
  not_found: "Mailbox not found.",
  wrong_account: "Sign in as the same email account to turn on sending for it.",
  no_send: "Permission to send was not given, so sending stays off.",
  send_failed: "Sending was not turned on. The mail service would not take the test message.",
};
export const linkErrorMessage = (code: string) => (Object.hasOwn(LINK_ERRORS, code) ? LINK_ERRORS[code] : "The mailbox could not be connected.");
export const linkErrorCode = (e: unknown) => (e instanceof AppError && typeof e.details?.link === "string" ? e.details.link : "failed");

const MAILBOX_KEY = [emailConnections.organizationId, emailConnections.provider, emailConnections.emailAddress];
const STILL_READING = sql`case when ${emailConnections.status} in ('reauth_required', 'active') then 'active' else 'pending' end`;
const pendingMailbox = (organizationId: string, userId: string, emailAddress: string) => ({
  organizationId, emailAddress, status: "pending" as const, authorizedBy: userId,
  authorizationStatement: AUTHORIZATION_STATEMENT, authorizedAt: new Date(), lastError: null,
});
const ownedBy = (id: string, orgId: string) => and(eq(emailConnections.id, id), eq(emailConnections.organizationId, orgId));

export const mayManageMailbox = (ctx: OfficeContext, conn: { authorizedBy: string | null }) =>
  can(ctx, "integrations.manage") || conn.authorizedBy === ctx.userId;

export async function ownMailbox(ctx: OfficeContext, connectionId: string): Promise<Connection> {
  requirePermission(ctx, "inbox.read");
  const [conn] = await withTenant(tenantScope(ctx), (tx) => tx.select().from(emailConnections).where(ownedBy(connectionId, ctx.orgId)));
  if (!conn) throw new AppError("not_found", "Mailbox not found.");
  if (!mayManageMailbox(ctx, conn)) throw forbidden();
  return conn;
}

const pkce = () => {
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

async function finishConnecting(orgId: string, userId: string, connectionId: string) {
  const setup = `/constituent-center/setup?mailbox=${connectionId}`;
  const db = await systemDb();
  await db.update(officeSettings).set({ requireMfa: true, updatedAt: new Date() }).where(eq(officeSettings.organizationId, orgId));
  const [u] = await db.select({ enabledAt: users.mfaEnabledAt }).from(users).where(eq(users.id, userId));
  return u?.enabledAt ? setup : `/account/mfa?required=1&next=${encodeURIComponent(setup)}`;
}

export async function startMailboxConnection(ctx: OfficeContext, provider: "google" | "microsoft", acknowledged: boolean, opts: { sendFor?: string } = {}) {
  requirePermission(ctx, "inbox.read");
  if (!acknowledged) throw new AppError("validation", "Confirm that you are authorized to connect this mailbox.");
  const sending = opts.sendFor ? await ownMailbox(ctx, opts.sendFor) : null;
  if (sending && sending.provider !== provider) throw new AppError("validation", "That mailbox is linked a different way.");
  const cfg = integrationsConfigured();
  if (provider === "google" && !cfg.google) throw new AppError("unavailable", "Google sign-in is not configured for this deployment.");
  if (provider === "microsoft" && !cfg.microsoft) throw new AppError("unavailable", "Microsoft sign-in is not configured for this deployment.");
  const state = randomToken(24);
  const { verifier, challenge } = pkce();
  const db = await systemDb();
  await db.insert(oauthStates).values({
    state, organizationId: ctx.orgId, userId: ctx.userId, provider, codeVerifierEnc: encryptSecret(verifier),
    payload: sending ? { sendFor: sending.id } : {}, expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const hint = sending?.emailAddress;
  return provider === "google"
    ? googleAuthUrl(state, challenge, sending ? GMAIL_SCOPES.send : GMAIL_SCOPES.read, hint)
    : microsoftAuthUrl(state, challenge, sending ? GRAPH_SCOPES.send : GRAPH_SCOPES.read, hint);
}

// The state row binds the callback to the user and office that started it.
export async function completeMailboxConnection(provider: "google" | "microsoft", code: string, state: string, sessionUserId: string) {
  const db = await systemDb();
  const [row] = await db.select().from(oauthStates).where(and(eq(oauthStates.state, state), isNull(oauthStates.usedAt)));
  if (!row || row.provider !== provider || row.expiresAt < new Date()) throw new AppError("validation", LINK_ERRORS.expired, { link: "expired" });
  if (row.userId !== sessionUserId) throw new AppError("forbidden", LINK_ERRORS.other_user, { link: "other_user" });
  await db.update(oauthStates).set({ usedAt: new Date() }).where(eq(oauthStates.state, state));
  const verifier = decryptSecret(row.codeVerifierEnc);

  const sendFor = typeof row.payload.sendFor === "string" ? row.payload.sendFor : null;
  const tokens =
    provider === "google"
      ? await googleExchangeCode(code, verifier)
      : await microsoftExchangeCode(code, verifier, sendFor ? GRAPH_SCOPES.send : GRAPH_SCOPES.read);
  // Google's consent screen lets people untick reading mail.
  if (provider === "google" && !sendFor && tokens.scopes.length && !gmailGrantsRead(tokens.scopes)) {
    throw new AppError("validation", LINK_ERRORS.no_read, { link: "no_read" });
  }
  const accessNow = async () => tokens.accessToken;
  const address =
    provider === "google"
      ? (await new GmailClient(accessNow).getProfile()).emailAddress
      : await new GraphClient(accessNow).me().then((m) => m.mail ?? m.userPrincipalName);

  const granted = tokens.scopes.length ? tokens.scopes : provider === "google" ? GMAIL_SCOPES.read : GRAPH_SCOPES.read;
  const grantsSend = provider === "google" ? gmailGrantsSend(granted) : graphGrantsSend(granted);
  if (sendFor) {
    const [existing] = await withTenant({ orgId: row.organizationId, userId: row.userId }, (tx) =>
      tx.select().from(emailConnections).where(ownedBy(sendFor, row.organizationId)),
    );
    if (!existing || existing.provider !== provider) throw new AppError("not_found", LINK_ERRORS.not_found, { link: "not_found" });
    if (existing.emailAddress !== address.toLowerCase()) {
      throw new AppError("validation", `Sign in as ${existing.emailAddress} to turn on sending for it.`, { link: "wrong_account" });
    }
    if (!grantsSend) throw new AppError("validation", LINK_ERRORS.no_send, { link: "no_send" });
    const [connection] = await withTenant({ orgId: row.organizationId, userId: row.userId }, (tx) =>
      tx
        .update(emailConnections)
        .set({
          scopes: granted, accessTokenEnc: encryptSecret(tokens.accessToken),
          ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}), tokenExpiresAt: tokens.expiresAt, lastError: null,
        })
        .where(eq(emailConnections.id, existing.id))
        .returning(),
    );
    return { connection, next: `/constituent-center/setup?sending=${connection.id}`, sendFor: connection.id };
  }

  const values = {
    ...pendingMailbox(row.organizationId, row.userId, address.toLowerCase()), provider, authMode: "delegated" as const, scopes: granted,
    accessTokenEnc: encryptSecret(tokens.accessToken), refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresAt,
  };
  const connection = await withTenant({ orgId: row.organizationId, userId: row.userId }, async (tx) => {
    const [c] = await tx
      .insert(emailConnections)
      .values(values)
      .onConflictDoUpdate({
        target: MAILBOX_KEY,
        // Relinking never turns sending on, and turns it off if the new grant cannot send.
        set: { ...values, status: STILL_READING, ...(grantsSend ? {} : { sendEnabledAt: null, sendEnabledBy: null }) },
      })
      .returning();
    const by: OfficeContext = { orgId: row.organizationId, userId: row.userId, roleKey: "", permissions: new Set(), actor: "user" };
    await audit(tx, by, "mailbox.connected", "email_connection", c.id, { provider, mode: "delegated" });
    return c;
  });
  return { connection, next: await finishConnecting(row.organizationId, row.userId, connection.id), sendFor: null };
}

// All offices share one app, so a mailbox must be on a domain this office proved.
export async function connectMicrosoftApplication(ctx: OfficeContext, input: { tenantId: string; mailbox: string; acknowledged: boolean }) {
  requirePermission(ctx, "integrations.manage");
  if (!input.acknowledged) throw new AppError("validation", "Confirm that you are authorized to connect this mailbox.");
  if (!integrationsConfigured().microsoft) throw new AppError("unavailable", "Microsoft sign-in is not configured for this deployment.");
  const tenantId = input.tenantId.trim();
  const mailbox = input.mailbox.trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new AppError("validation", "Enter the Microsoft tenant ID.");
  if (!EMAIL_ADDRESS.test(mailbox)) throw new AppError("validation", "Enter the mailbox's email address.");
  const domain = mailbox.split("@")[1];
  const [own] = await withTenant(tenantScope(ctx), (tx) =>
    tx
      .select({ id: emailConnections.id })
      .from(emailConnections)
      .where(and(
        eq(emailConnections.organizationId, ctx.orgId), eq(emailConnections.provider, "microsoft"), eq(emailConnections.authMode, "delegated"),
        eq(emailConnections.status, "active"), sql`split_part(${emailConnections.emailAddress}, '@', 2) = ${domain}`,
      ))
      .limit(1),
  );
  if (!own) throw new AppError("validation", `First link your own Outlook account from ${domain}.`);
  const db = await systemDb();
  const [taken] = await db
    .select({ id: emailConnections.id })
    .from(emailConnections)
    .where(and(eq(emailConnections.emailAddress, mailbox), ne(emailConnections.organizationId, ctx.orgId), ne(emailConnections.status, "disconnected")))
    .limit(1);
  if (taken) throw new AppError("conflict", "Another office has already connected this mailbox.");
  try {
    const t = await microsoftAppToken(tenantId);
    await new GraphClient(async () => t.accessToken, mailbox).listFolders();
  } catch (e) {
    if (e instanceof ProviderHttpError && (e.status === 401 || e.status === 403)) {
      throw new AppError("validation", "Microsoft refused access to that mailbox. The mailbox's admin needs to grant read access for this app, scoped to this mailbox.");
    }
    throw e;
  }
  const connection = await withTenant(tenantScope(ctx), async (tx) => {
    const mode = { provider: "microsoft" as const, authMode: "application" as const, tenantId, scopes: ["Mail.Read"] };
    const values = { ...pendingMailbox(ctx.orgId, ctx.userId, mailbox), ...mode };
    const [c] = await tx.insert(emailConnections).values(values).onConflictDoUpdate({ target: MAILBOX_KEY, set: values }).returning();
    await audit(tx, ctx, "mailbox.connected", "email_connection", c.id, { provider: "microsoft", mode: "application" });
    return c;
  });
  return { id: connection.id, next: await finishConnecting(ctx.orgId, ctx.userId, connection.id) };
}

type MailboxAnswer = {
  label: string; signIn: "google" | "microsoft" | null; password: boolean;
  appPasswordUrl: string | null; appPassword: AppPasswordShape | null; twoStepUrl: string | null; outlook: boolean;
};

export async function describeMailbox(ctx: OfficeContext, email: string): Promise<MailboxAnswer> {
  requirePermission(ctx, "inbox.read");
  const address = email.trim().toLowerCase();
  if (!EMAIL_ADDRESS.test(address)) throw new AppError("validation", "Enter a full email address.");
  const service = await findMailService(address);
  const cfg = integrationsConfigured();
  const signIn = service.kind === "google" && cfg.google ? "google" : service.kind === "microsoft" && cfg.microsoft ? "microsoft" : null;
  const { label, appPasswordUrl, appPassword, twoStepUrl } = service;
  return { label, signIn, password: service.kind !== "microsoft", appPasswordUrl, appPassword, twoStepUrl, outlook: service.kind === "microsoft" };
}

async function firstServerThatAnswers(service: MailService, user: string, password: string) {
  let last: unknown = new Error("No mail server found.");
  for (const host of service.hosts) {
    try {
      const session = await openImap({ host, user, password });
      await session.listFolders();
      await session.close();
      return host;
    } catch (e) {
      last = e;
      if (isImapLoginRefused(e)) break;
    }
  }
  throw last;
}

export async function connectPasswordMailbox(ctx: OfficeContext, input: { email: string; password: string; acknowledged: boolean }) {
  requirePermission(ctx, "inbox.read");
  if (!input.acknowledged) throw new AppError("validation", "Confirm that you are authorized to connect this mailbox.");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_ADDRESS.test(email)) throw new AppError("validation", "Enter a full email address.");
  const service = await findMailService(email);
  if (service.kind === "microsoft") throw new AppError("validation", "Outlook mailboxes connect with Connect Outlook.");
  if (!input.password.trim()) throw new AppError("validation", "Enter the app password.");
  const wrongKind = appPasswordProblem(service.label, service.appPassword, input.password);
  if (wrongKind) throw new AppError("validation", wrongKind);
  const password = cleanAppPassword(service.appPassword, input.password);
  let host: string;
  try {
    host = await firstServerThatAnswers(service, email, password);
  } catch (e) {
    if (isImapLoginRefused(e)) {
      throw new AppError("validation", `${service.label} did not accept that. Use an app password made for this, not your regular password.`);
    }
    throw new AppError("validation", `Could not reach a mail server for ${email.split("@")[1]}.`);
  }
  const connection = await withTenant(tenantScope(ctx), async (tx) => {
    const values = {
      ...pendingMailbox(ctx.orgId, ctx.userId, email), provider: "imap" as const, authMode: "password" as const, scopes: ["read-only"],
      refreshTokenEnc: encryptSecret(JSON.stringify({ host, password })),
    };
    const [c] = await tx
      .insert(emailConnections)
      .values(values)
      .onConflictDoUpdate({ target: MAILBOX_KEY, set: { ...values, status: STILL_READING, sendEnabledAt: null, sendEnabledBy: null } })
      .returning();
    await audit(tx, ctx, "mailbox.connected", "email_connection", c.id, { provider: "imap", mode: "password" });
    return c;
  });
  return { id: connection.id, next: await finishConnecting(ctx.orgId, ctx.userId, connection.id) };
}

const needsReconnect = (conn: Connection, lastError: string) =>
  withTenant({ orgId: conn.organizationId }, (tx) =>
    tx.update(emailConnections).set({ status: "reauth_required", lastError }).where(eq(emailConnections.id, conn.id)),
  );

export const imapSecret = (conn: Pick<Connection, "refreshTokenEnc">) => JSON.parse(decryptSecret(conn.refreshTokenEnc!)) as { host: string; password: string };

const imapSessions = new Map<string, { open: Promise<ImapSession>; queue: Promise<unknown>; active: number; timer: NodeJS.Timeout | null }>();

export async function withImap<T>(conn: Connection, fn: (session: ImapSession) => Promise<T>): Promise<T> {
  let held = imapSessions.get(conn.id);
  if (!held) {
    const { host, password } = imapSecret(conn);
    held = { open: openImap({ host, user: conn.emailAddress, password }), queue: Promise.resolve(), active: 0, timer: null };
    imapSessions.set(conn.id, held);
  }
  const entry = held;
  if (entry.timer) clearTimeout(entry.timer);
  entry.active++;
  const release = () => {
    imapSessions.delete(conn.id);
    entry.open.then((s) => s.close()).catch(() => undefined);
  };
  const job = entry.queue.then(async () => fn(await entry.open));
  entry.queue = job.catch(() => undefined);
  try {
    return await job;
  } catch (e) {
    if (imapSessions.get(conn.id) === entry) release();
    if (isImapLoginRefused(e)) {
      await needsReconnect(conn, "The mail service stopped accepting the app password. Connect it again.");
      const message = "The app password stopped working; connect the mailbox again.";
      await recordIntegrationError(conn.organizationId, conn.id, conn.provider, "login", "auth_failed", message);
      throw new PermanentJobError("Mailbox password refused");
    }
    throw e;
  } finally {
    entry.active--;
    if (entry.active === 0 && imapSessions.get(conn.id) === entry) {
      entry.timer = setTimeout(release, 20_000);
      entry.timer.unref?.();
    }
  }
}

export const graphFor = (conn: Connection) => new GraphClient(tokenProvider(conn), conn.authMode === "application" ? conn.emailAddress : null);

// "Sent", "Sent Items", "INBOX.Sent", "[Gmail]/Sent Mail"
export const SENT_NAME = /(^|[/.\]])sent(\s+(mail|items|messages))?$/i;

export async function listMailboxFolders(ctx: OfficeContext, connectionId: string) {
  const conn = await ownMailbox(ctx, connectionId);
  if (conn.provider === "imap") {
    const folders = await withImap(conn, (s) => s.listFolders());
    return folders.map((f) => ({ id: f.path, name: f.path, isInbox: f.isInbox, isSent: f.isSent ?? SENT_NAME.test(f.path) }));
  }
  if (conn.provider === "google") {
    const labels = await new GmailClient(tokenProvider(conn)).listLabels();
    return labels
      .filter((l) => (l.type === "system" ? ["INBOX", "SENT"].includes(l.id) : true))
      .map((l) => ({ id: l.id, name: l.id === "INBOX" ? "Inbox" : l.id === "SENT" ? "Sent" : l.name, isInbox: l.id === "INBOX", isSent: l.id === "SENT" }));
  }
  const graph = graphFor(conn);
  const [folders, sent] = await Promise.all([graph.listFolders(), graph.sentFolder().catch(() => null)]);
  return folders.map((f) => ({
    id: f.id, name: f.displayName, isInbox: /^inbox$/i.test(f.displayName), isSent: sent ? f.id === sent.id : /^sent items$/i.test(f.displayName),
  }));
}

type Folder = { id: string; name: string };
type FolderChoice = { folders: Folder[]; importFrom: string; importTo?: string | null; sentFolder?: Folder | null };

export async function configureMailbox(ctx: OfficeContext, connectionId: string, input: FolderChoice) {
  await ownMailbox(ctx, connectionId);
  if (!input.folders.length) throw new AppError("validation", "Choose at least one folder.");
  const from = new Date(`${input.importFrom}T00:00:00Z`);
  if (Number.isNaN(from.getTime())) throw new AppError("validation", "Choose an import start date.");
  const sent = input.sentFolder && !input.folders.some((f) => f.id === input.sentFolder!.id) ? input.sentFolder : null;
  await withTenant(tenantScope(ctx), async (tx) => {
    const [conn] = await tx.select().from(emailConnections).where(ownedBy(connectionId, ctx.orgId));
    if (!conn) throw new AppError("not_found", "Mailbox not found.");
    await tx
      .update(emailConnections)
      .set({ selectedFolders: input.folders, sentFolder: sent, importFrom: input.importFrom, importTo: input.importTo ?? null, status: "active" })
      .where(eq(emailConnections.id, connectionId));
    if (conn.provider === "google") {
      await tx.insert(emailSyncState).values({ organizationId: ctx.orgId, connectionId, folderId: "*", cursorType: "gmail_history" }).onConflictDoNothing();
    } else {
      const cursorType = conn.provider === "imap" ? ("imap_uid" as const) : ("graph_delta" as const);
      const wanted = [...input.folders.map((f) => ({ ...f, purpose: "mail" as const })), ...(sent ? [{ ...sent, purpose: "sent" as const }] : [])];
      const kept = await tx
        .select({ id: emailSyncState.id, folderId: emailSyncState.folderId, purpose: emailSyncState.purpose })
        .from(emailSyncState)
        .where(eq(emailSyncState.connectionId, connectionId));
      for (const k of kept) {
        if (!wanted.some((w) => w.id === k.folderId && w.purpose === k.purpose)) await tx.delete(emailSyncState).where(eq(emailSyncState.id, k.id));
      }
      for (const f of wanted) {
        const row = { organizationId: ctx.orgId, connectionId, folderId: f.id, folderName: f.name, purpose: f.purpose, cursorType };
        await tx.insert(emailSyncState).values(row).onConflictDoNothing();
      }
    }
    const folders = input.folders.map((f) => f.name);
    await audit(tx, ctx, "mailbox.configured", "email_connection", connectionId, { folders, sent: sent?.name ?? null, importFrom: input.importFrom });
    const folderKey = [...input.folders.map((f) => f.id), ...(sent ? [`sent:${sent.id}`] : [])].sort().join(",");
    await enqueue("mail.backfill", { connectionId }, { orgId: ctx.orgId, idempotencyKey: `backfill:${connectionId}:${input.importFrom}:${folderKey}` }, tx);
  });
}

export async function disconnectMailbox(ctx: OfficeContext, connectionId: string) {
  await ownMailbox(ctx, connectionId);
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx
      .update(emailConnections)
      .set({ status: "disconnected", accessTokenEnc: null, refreshTokenEnc: null, appPasswordEnc: null, sendEnabledAt: null, sendEnabledBy: null })
      .where(ownedBy(connectionId, ctx.orgId));
    await audit(tx, ctx, "mailbox.disconnected", "email_connection", connectionId);
  });
}

export async function getConnection(orgId: string, connectionId: string): Promise<Connection> {
  const [c] = await withTenant({ orgId }, (tx) => tx.select().from(emailConnections).where(ownedBy(connectionId, orgId)));
  if (!c) throw new PermanentJobError("Mailbox connection not found");
  return c;
}

export async function recordIntegrationError(
  orgId: string, connectionId: string | null, provider: string, operation: string, errorCode: string, message: string,
) {
  await withTenant({ orgId }, async (tx) => {
    const [existing] = await tx
      .select({ id: integrationErrors.id })
      .from(integrationErrors)
      .where(and(
        eq(integrationErrors.organizationId, orgId), eq(integrationErrors.operation, operation), eq(integrationErrors.errorCode, errorCode),
        isNull(integrationErrors.resolvedAt), connectionId ? eq(integrationErrors.connectionId, connectionId) : sql`true`,
      ))
      .limit(1);
    if (existing) {
      await tx
        .update(integrationErrors)
        .set({ occurrences: sql`${integrationErrors.occurrences} + 1`, lastSeenAt: new Date(), message })
        .where(eq(integrationErrors.id, existing.id));
    } else await tx.insert(integrationErrors).values({ organizationId: orgId, connectionId, provider, operation, errorCode, message });
  });
}

export async function resolveIntegrationErrors(
  orgId: string, connectionId: string, operations: string[], opts: { exceptCode?: string; lastSeenBefore?: Date } = {},
) {
  await withTenant({ orgId }, (tx) =>
    tx
      .update(integrationErrors)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(integrationErrors.organizationId, orgId),
          eq(integrationErrors.connectionId, connectionId),
          inArray(integrationErrors.operation, operations),
          isNull(integrationErrors.resolvedAt),
          opts.exceptCode ? ne(integrationErrors.errorCode, opts.exceptCode) : undefined,
          opts.lastSeenBefore ? lt(integrationErrors.lastSeenAt, opts.lastSeenBefore) : undefined,
        ),
      ),
  );
}

export function tokenProvider(conn: Connection) {
  let cached: { token: string; expiresAt: Date } | null =
    conn.accessTokenEnc && conn.tokenExpiresAt ? { token: decryptSecret(conn.accessTokenEnc), expiresAt: conn.tokenExpiresAt } : null;
  return async () => {
    if (conn.status === "disconnected") throw new PermanentJobError("Mailbox is disconnected");
    if (cached && cached.expiresAt.getTime() > Date.now() + 30_000) return cached.token;
    let tokens: TokenSet;
    try {
      if (conn.authMode === "application") {
        if (!conn.tenantId) throw new PermanentJobError("No tenant recorded; reconnect the mailbox");
        tokens = await microsoftAppToken(conn.tenantId);
        // App-only tokens are short-lived and never stored.
        cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
        return tokens.accessToken;
      }
      if (!conn.refreshTokenEnc) throw new PermanentJobError("No refresh token; reconnect the mailbox");
      const refresh = decryptSecret(conn.refreshTokenEnc);
      const scopes = conn.scopes.length ? conn.scopes : GRAPH_SCOPES.read;
      tokens = conn.provider === "google" ? await googleRefresh(refresh) : await microsoftRefresh(refresh, scopes);
    } catch (e) {
      if (e instanceof ProviderHttpError && (e.code === "invalid_grant" || e.status === 400 || e.status === 401)) {
        await needsReconnect(conn, "Access was revoked or expired. Reconnect this mailbox.");
        const message = "Authorization revoked or expired; reconnect required.";
        await recordIntegrationError(conn.organizationId, conn.id, conn.provider, "token_refresh", e.code, message);
        throw new PermanentJobError("Mailbox authorization revoked");
      }
      throw e;
    }
    await withTenant({ orgId: conn.organizationId }, (tx) =>
      tx
        .update(emailConnections)
        .set({
          accessTokenEnc: encryptSecret(tokens.accessToken), tokenExpiresAt: tokens.expiresAt,
          ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
        })
        .where(eq(emailConnections.id, conn.id)),
    );
    cached = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    return tokens.accessToken;
  };
}
