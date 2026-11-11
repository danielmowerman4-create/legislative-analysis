import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { systemDb } from "../db/client";
import { emailConnections, emailSyncState, webhookDeliveries } from "../db/schema";
import { getEnv } from "../env";
import { safeEqual, sha256 } from "../crypto";
import { enqueue } from "../jobs/queue";
import { logger } from "../logger";

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifyPubsubToken(authorization: string | null): Promise<boolean> {
  const env = getEnv();
  if (!env.GOOGLE_PUBSUB_AUDIENCE || !env.GOOGLE_PUBSUB_SERVICE_ACCOUNT || !authorization?.startsWith("Bearer ")) return false;
  try {
    const issuer = ["https://accounts.google.com", "accounts.google.com"];
    const { payload } = await jwtVerify(authorization.slice(7), GOOGLE_JWKS, { issuer, audience: env.GOOGLE_PUBSUB_AUDIENCE });
    // Any Google service account can mint tokens for any audience; pin the sender.
    if (payload.email !== env.GOOGLE_PUBSUB_SERVICE_ACCOUNT) return false;
    return payload.email_verified === true;
  } catch {
    return false;
  }
}

type DeliveryStatus = "enqueued" | "duplicate" | "rejected" | "ignored";

async function recordDelivery(provider: "google" | "microsoft", deliveryKey: string, connectionId: string | null, status: DeliveryStatus, reason?: string) {
  const db = await systemDb();
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ provider, deliveryKey, connectionId, status, reason })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.id });
  return Boolean(row);
}

export async function processGmailPush(body: unknown): Promise<{ status: number; outcome: string }> {
  const msg = (body as { message?: { data?: string; messageId?: string; message_id?: string } })?.message;
  const deliveryId = msg?.messageId ?? msg?.message_id;
  if (!msg?.data || !deliveryId) return { status: 400, outcome: "malformed" };
  let data: { emailAddress?: string; historyId?: string | number };
  try {
    data = JSON.parse(Buffer.from(msg.data, "base64").toString("utf8"));
  } catch {
    return { status: 400, outcome: "malformed" };
  }
  const address = String(data.emailAddress ?? "").toLowerCase();
  const db = await systemDb();
  const conns = await db
    .select({ id: emailConnections.id, orgId: emailConnections.organizationId })
    .from(emailConnections)
    .where(and(eq(emailConnections.provider, "google"), eq(emailConnections.emailAddress, address), eq(emailConnections.status, "active")));
  const key = `gmail:${deliveryId}`;
  if (!conns.length) {
    await recordDelivery("google", key, null, "ignored", "no active connection");
    return { status: 204, outcome: "ignored" };
  }
  const fresh = await recordDelivery("google", key, conns[0].id, "enqueued");
  if (!fresh) return { status: 204, outcome: "duplicate" };
  for (const c of conns) {
    const idempotencyKey = `gmail-inc:${c.id}:${data.historyId ?? deliveryId}`;
    await enqueue("mail.incremental", { connectionId: c.id, hint: String(data.historyId ?? "") }, { orgId: c.orgId, idempotencyKey });
  }
  return { status: 204, outcome: "enqueued" };
}

type GraphNotification = {
  subscriptionId: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
  lifecycleEvent?: "reauthorizationRequired" | "subscriptionRemoved" | "missed";
};

export async function processGraphNotifications(body: unknown): Promise<{ status: number; enqueued: number; rejected: number }> {
  const items = ((body as { value?: GraphNotification[] })?.value ?? []).slice(0, 200);
  const db = await systemDb();
  let enqueued = 0;
  let rejected = 0;
  for (const n of items) {
    const [state] = await db
      .select({
        id: emailSyncState.id, orgId: emailSyncState.organizationId, connectionId: emailSyncState.connectionId, folderId: emailSyncState.folderId,
        clientStateHash: emailSyncState.clientStateHash,
      })
      .from(emailSyncState)
      .where(eq(emailSyncState.subscriptionId, n.subscriptionId))
      .limit(1);
    const key = `graph:${n.subscriptionId}:${n.lifecycleEvent ?? n.changeType}:${n.resourceData?.id ?? n.resource ?? ""}`;
    if (!state || !state.clientStateHash || !n.clientState || !safeEqual(sha256(n.clientState), state.clientStateHash)) {
      rejected++;
      // Unauthenticated, so log only and write nothing.
      logger.warn("webhook.graph.rejected", { known: Boolean(state) });
      continue;
    }
    if (!(await recordDelivery("microsoft", key, state.connectionId, "enqueued"))) continue;
    if (n.lifecycleEvent === "reauthorizationRequired" || n.lifecycleEvent === "subscriptionRemoved") {
      await enqueue("mail.renew_subscriptions", {}, { idempotencyKey: `graph-renew:${state.id}:${Math.floor(Date.now() / 600_000)}` });
    }
    const idempotencyKey = `graph-inc:${state.id}:${n.resourceData?.id ?? n.lifecycleEvent ?? Date.now()}`;
    await enqueue("mail.incremental", { connectionId: state.connectionId, folderId: state.folderId }, { orgId: state.orgId, idempotencyKey });
    enqueued++;
  }
  return { status: 202, enqueued, rejected };
}
