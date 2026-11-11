import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import { emailDrafts, emailMessages, messageEvents, replyDeliveries } from "../db/schema";
import { normalizeSubject } from "../email/normalize";
import type { MailEnvelope } from "../email/providers/imap";

const REPLY_SUBJECT = /^\s*(re|aw|sv|antw)\s*(\[\d+\])?\s*:/i;
const lower = (list: string[]) => [...new Set(list.map((a) => a.toLowerCase()))];
const textArray = (list: string[]) => sql`array[${sql.join(list.map((v) => sql`${v}`), sql`, `)}]::text[]`;

async function lettersAnswered(tx: Db, orgId: string, connectionId: string | null, env: MailEnvelope): Promise<string[]> {
  const to = lower(env.to);
  if (!to.length) return [];
  const sentAt = env.sentAt ?? new Date();
  const refs = [env.inReplyTo, ...env.references].filter((x): x is string => Boolean(x));
  const subject = REPLY_SUBJECT.test(env.subject) ? normalizeSubject(env.subject) : "";
  const ties = [
    refs.length ? sql`m.rfc_message_id in (${sql.join(refs.map((r) => sql`${r}`), sql`, `)})` : null,
    env.threadId && connectionId ? sql`(t.connection_id = ${connectionId} and t.provider_thread_id = ${env.threadId})` : null,
    subject ? sql`t.subject_normalized = ${subject}` : null,
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));
  if (!ties.length) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    select m.id from email_messages m
    left join email_threads t on t.id = m.thread_id
    where m.organization_id = ${orgId} and m.direction = 'inbound'
      and (lower(m.from_address) = any(${textArray(to)}) or lower(m.claimed_address) = any(${textArray(to)}))
      and least(m.sent_at, m.received_at) <= ${new Date(sentAt.getTime() + 5 * 60_000).toISOString()}::timestamptz
      and greatest(m.sent_at, m.received_at) >= ${new Date(sentAt.getTime() - 180 * 86400_000).toISOString()}::timestamptz
      and (${sql.join(ties, sql` or `)})`);
  return rows.rows.map((r) => r.id);
}

export async function answersOfficeMail(orgId: string, connectionId: string, env: MailEnvelope) {
  return withTenant({ orgId }, async (tx) => {
    if (env.rfcMessageId) {
      const [own] = await tx.select({ id: replyDeliveries.id }).from(replyDeliveries)
        .where(and(eq(replyDeliveries.organizationId, orgId), eq(replyDeliveries.rfcMessageId, env.rfcMessageId))).limit(1);
      if (own) return true;
    }
    return (await lettersAnswered(tx, orgId, connectionId, env)).length > 0;
  });
}

export async function recordReply(tx: Db, orgId: string, connectionId: string | null, sent: { id: string; sentAt: Date } & MailEnvelope) {
  if (sent.rfcMessageId) {
    const [own] = await tx.select().from(replyDeliveries)
      .where(and(eq(replyDeliveries.organizationId, orgId), eq(replyDeliveries.rfcMessageId, sent.rfcMessageId))).limit(1);
    if (own) {
      if (own.status !== "sent") await markDelivered(tx, orgId, own.id, own.draftId, own.messageId, sent.sentAt, null);
      return;
    }
  }
  const ids = await lettersAnswered(tx, orgId, connectionId, sent);
  if (!ids.length) return;
  const near = await tx.select({ messageId: messageEvents.messageId }).from(messageEvents)
    .where(and(
      eq(messageEvents.organizationId, orgId), inArray(messageEvents.messageId, ids), eq(messageEvents.type, "reply_sent"),
      sql`abs(extract(epoch from (${messageEvents.createdAt} - ${sent.sentAt.toISOString()}::timestamptz))) < 900`,
    ));
  const fresh = ids.filter((id) => !near.some((n) => n.messageId === id));
  if (fresh.length) {
    await tx.insert(messageEvents).values(fresh.map((messageId) => ({
      organizationId: orgId, messageId, type: "reply_sent", data: { outboundMessageId: sent.id, via: "mailbox" }, createdAt: sent.sentAt,
    })));
  }
  await tx.update(emailMessages).set({ triageStatus: "done" })
    .where(and(eq(emailMessages.organizationId, orgId), inArray(emailMessages.id, ids), inArray(emailMessages.triageStatus, ["new", "in_progress"])));
  await tx.update(emailDrafts).set({ status: "sent", sentAt: sent.sentAt, sentVia: "mailbox" })
    .where(and(eq(emailDrafts.organizationId, orgId), inArray(emailDrafts.replyToMessageId, ids), eq(emailDrafts.status, "approved")));
}

export async function markDelivered(
  tx: Db, orgId: string, deliveryId: string, draftId: string, messageId: string | null, sentAt: Date, providerMessageId: string | null,
) {
  await tx.update(replyDeliveries).set({ status: "sent", sentAt, error: null, ...(providerMessageId ? { providerMessageId } : {}) })
    .where(eq(replyDeliveries.id, deliveryId));
  if (messageId) {
    await tx.insert(messageEvents)
      .values({ organizationId: orgId, messageId, type: "reply_sent", data: { draftId, deliveryId, via: "app" }, createdAt: sentAt });
    await tx.update(emailMessages).set({ triageStatus: "done" })
      .where(and(eq(emailMessages.id, messageId), inArray(emailMessages.triageStatus, ["new", "in_progress"])));
  }
  const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(replyDeliveries)
    .where(and(eq(replyDeliveries.draftId, draftId), sql`${replyDeliveries.status} <> 'sent'`));
  if (!left.n) {
    await tx.update(emailDrafts).set({ status: "sent", sentAt, sentVia: "app" })
      .where(and(eq(emailDrafts.id, draftId), inArray(emailDrafts.status, ["sending", "approved"])));
  }
}
