import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import {
  bills, contacts, emailConnections, emailDrafts, emailMessages, emailThreads, messageBillLinks, messageEvents, officeSettings, organizations, replyDeliveries,
  trackedBills, users,
} from "../db/schema";
import { can, requirePermission, systemContext, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, forbidden, notFound } from "../errors";
import { enqueue, RetryLaterError } from "../jobs/queue";
import { getConnection } from "../email/connections";
import { mailboxCanSend, newMessageId, sendFailure, sendFromMailbox } from "../email/send";
import { markDelivered } from "./answered";
import { getAiProvider } from "../ai/provider";
import { STATUS_LABEL } from "../legislation/normalize";
import { extractBillMentions } from "../classification/bills";
import { maskForModel } from "../classification/preprocess";
import { audit } from "./audit";
import { mayRead } from "./center";

const RESTRICTED = "This message is restricted to staff who handle sensitive casework.";

async function assertMayAnswer(tx: Db, ctx: OfficeContext, draftId: string) {
  const [m] = await tx.select({ isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo }).from(emailDrafts)
    .innerJoin(emailMessages, eq(emailMessages.id, emailDrafts.replyToMessageId))
    .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.organizationId, ctx.orgId)));
  if (m && !mayRead(ctx, m)) throw forbidden(RESTRICTED);
}

const redactReply = <T extends { subject: string; bodyText: string; isSensitive: boolean | null; assignedTo: string | null }>(ctx: OfficeContext, r: T): T =>
  mayRead(ctx, { isSensitive: Boolean(r.isSensitive), assignedTo: r.assignedTo }) ? r : { ...r, subject: "Sensitive message", bodyText: "" };

const POSITION_LINE: Record<string, (who: string, bill: string) => string> = {
  support: (who, bill) => `${who} supports ${bill}.`, oppose: (who, bill) => `${who} opposes ${bill}.`, neutral: (who, bill) => `${who} is neutral on ${bill}.`,
};

type BillFacts = { identifier: string; title: string; status: keyof typeof STATUS_LABEL; lastActionAt: string | null; lastActionText: string | null };

export function billFactLines(b: BillFacts, recorded: string | null | undefined, who: string): string[] {
  const status = `${b.identifier} (${b.title}) is currently: ${STATUS_LABEL[b.status]}${b.lastActionText ? `; most recent action${b.lastActionAt ? ` on ${b.lastActionAt}` : ""}: ${b.lastActionText}` : ""}.`;
  const line = recorded ? POSITION_LINE[recorded]?.(who, b.identifier) : undefined;
  return [status, line ?? `This office has not taken a position on ${b.identifier}.`];
}

const POSITION_WORDS = /\b(support|supports|supporting|oppose|opposes|opposing|vote[sd]?\s+(?:for|against|yes|no)|will\s+vote|in\s+favor|against\s+(?:the|this)\s+bill)\b/i;

// AI writes only the opening; one that names a bill or takes a side is dropped.
export async function createReplyDraft(ctx: OfficeContext, messageId: string) {
  requirePermission(ctx, "communications.draft");
  const data = await withTenant(tenantScope(ctx), async (tx) => {
    const [m] = await tx.select().from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, ctx.orgId)));
    if (!m) throw notFound("Message not found.");
    if (!mayRead(ctx, m)) throw forbidden(RESTRICTED);
    if (m.direction !== "inbound") throw new AppError("validation", "Replies are drafted for received messages.");
    if (m.senderTrust === "failed" || m.senderTrust === "unverified") throw new AppError("validation", "Confirm who sent this before drafting a reply.");
    if (m.senderTrust === "relay" && !m.claimedAddress) {
      throw new AppError("validation", "The advocacy platform did not say who wrote this, so there is no one to reply to.");
    }
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const [contact] = m.contactId ? await tx.select().from(contacts).where(eq(contacts.id, m.contactId)) : [];
    const links = await tx.select().from(messageBillLinks)
      .where(and(eq(messageBillLinks.messageId, messageId), inArray(messageBillLinks.status, ["provisional", "confirmed"])));
    const billIds = links.map((l) => l.billId).filter((x): x is string => Boolean(x));
    const linked = billIds.length ? await tx.select().from(bills).where(inArray(bills.id, billIds)) : [];
    const tracked = billIds.length
      ? await tx.select({ billId: trackedBills.billId, position: trackedBills.position }).from(trackedBills)
        .where(and(eq(trackedBills.organizationId, ctx.orgId), inArray(trackedBills.billId, billIds)))
      : [];
    const [settings] = await tx.select({ ai: officeSettings.aiEnabled, consent: officeSettings.aiConsentAt, signature: officeSettings.replySignature })
      .from(officeSettings).where(eq(officeSettings.organizationId, ctx.orgId));
    return { m, org, contact, linked, tracked, ai: Boolean(settings?.ai && settings.consent), signature: settings?.signature?.trim() || null };
  });
  const { m, org, contact, linked, tracked } = data;
  const first = contact?.firstName ?? contact?.fullName?.split(" ")[0] ?? null;
  const who = org.legislatorName ?? "Our office";
  const topic = m.subject.replace(/^(re|fwd?):\s*/i, "");

  const facts = linked.flatMap((b) => billFactLines(b, tracked.find((t) => t.billId === b.id)?.position, who));

  let opening = `Thank you for contacting ${org.legislatorName ?? "our office"}${topic ? ` about ${topic}` : ""}.`;
  let aiGenerated = false;
  const provider = await getAiProvider(data.ai);
  if (provider) {
    const r = await provider.generate({
      system: "Write one or two courteous sentences acknowledging what a constituent wrote to their state legislator's office. Official office correspondence only. Do not name any bill, state any position, predict any vote, or promise any outcome.",
      sources: [{ id: `msg:${m.id}`, label: "Constituent message", text: maskForModel(m.substantiveText).slice(0, 4000) }],
      task: `Write the acknowledgement. Address the writer as ${first ?? "Constituent"} only if you use a name. Cite the source inline as [source:msg:${m.id}]; it will be removed before staff see the draft.`,
      maxTokens: 800,
    });
    const text = r?.text.replace(/\s*\[source:[^\]]+\]/g, "").trim();
    if (text && !POSITION_WORDS.test(text) && extractBillMentions(text, "").length === 0) {
      opening = text;
      aiGenerated = true;
    }
  }

  const body = [
    `Dear ${first ?? "Constituent"},`, "", opening, ...(facts.length ? ["", ...facts] : []), "", "[Office response]", "",
    ...(data.signature ? [data.signature] : ["Sincerely,", org.legislatorName ?? org.name]),
  ].join("\n");

  return withTenant(tenantScope(ctx), async (tx) => {
    const [d] = await tx.insert(emailDrafts)
      .values({
        organizationId: ctx.orgId, replyToMessageId: m.id, connectionId: m.connectionId, authorId: ctx.userId,
        toAddresses: [m.senderTrust === "relay" && m.claimedAddress ? m.claimedAddress : m.fromAddress],
        subject: m.subject.toLowerCase().startsWith("re:") ? m.subject : `Re: ${m.subject}`, bodyText: body, aiGenerated,
        citations: [{ type: "message", id: m.id, label: m.subject }, ...linked.map((b) => ({ type: "bill", id: b.id, label: b.identifier }))],
      })
      .returning();
    await audit(tx, ctx, "reply.drafted", "email_draft", d.id, { aiGenerated });
    return d;
  });
}

export async function updateReplyDraft(ctx: OfficeContext, draftId: string, bodyText: string) {
  requirePermission(ctx, "communications.draft");
  await withTenant(tenantScope(ctx), async (tx) => {
    await assertMayAnswer(tx, ctx, draftId);
    // Any change clears an approval: what was approved is exactly what goes out.
    await tx.update(emailDrafts).set({ bodyText: bodyText.slice(0, 50_000), updatedAt: new Date(), status: "draft", approvedBy: null, approvedAt: null })
      .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.organizationId, ctx.orgId), inArray(emailDrafts.status, ["draft", "approved"])));
  });
}

export async function discardReplyDraft(ctx: OfficeContext, draftId: string) {
  requirePermission(ctx, "communications.draft");
  await withTenant(tenantScope(ctx), (tx) =>
    tx.update(emailDrafts).set({ status: "discarded" })
      .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.organizationId, ctx.orgId), inArray(emailDrafts.status, ["draft", "approved"]))));
}

async function loadDraft(tx: Db, ctx: OfficeContext, draftId: string) {
  const [d] = await tx.select().from(emailDrafts).where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.organizationId, ctx.orgId)));
  if (!d) throw notFound("Draft not found.");
  return d;
}

export async function approveReplyDraft(ctx: OfficeContext, draftId: string) {
  requirePermission(ctx, "communications.approve");
  await withTenant(tenantScope(ctx), async (tx) => {
    const d = await loadDraft(tx, ctx, draftId);
    if (d.status !== "draft" && d.status !== "approved") throw new AppError("validation", "This reply has already gone out.");
    if (d.bodyText.includes("[Office response]")) throw new AppError("validation", "Replace [Office response] with the office's words before approving.");
    await tx.update(emailDrafts).set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date() }).where(eq(emailDrafts.id, draftId));
    await audit(tx, ctx, "reply.approved", "email_draft", draftId);
  });
}

const lettersOf = (d: typeof emailDrafts.$inferSelect) =>
  (d.replyToMessageId ? [d.replyToMessageId] : d.citations.filter((c) => c.type === "message").map((c) => c.id));

export async function markReplySent(ctx: OfficeContext, draftId: string) {
  requirePermission(ctx, "communications.draft");
  await withTenant(tenantScope(ctx), async (tx) => {
    const d = await loadDraft(tx, ctx, draftId);
    if (d.status !== "approved") throw new AppError("validation", "A reply is approved before it is sent.");
    await tx.update(emailDrafts).set({ status: "sent", sentBy: ctx.userId, sentAt: new Date(), sentVia: "marked" }).where(eq(emailDrafts.id, draftId));
    const answered = lettersOf(d);
    if (answered.length) {
      await tx.update(emailMessages).set({ triageStatus: "done" }).where(and(eq(emailMessages.organizationId, ctx.orgId), inArray(emailMessages.id, answered)));
      await tx.insert(messageEvents)
        .values(answered.map((messageId) => ({ organizationId: ctx.orgId, messageId, actorId: ctx.userId, type: "reply_sent", data: { draftId } })));
    }
    await audit(tx, ctx, "reply.marked_sent", "email_draft", draftId);
  });
}

async function recipientsOf(ctx: OfficeContext, draft: typeof emailDrafts.$inferSelect) {
  const ids = lettersOf(draft);
  if (!ids.length) return [];
  const wanted = new Set(draft.toAddresses.map((a) => a.toLowerCase()));
  const letters = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      id: emailMessages.id, fromAddress: emailMessages.fromAddress, fromName: emailMessages.fromName, claimedAddress: emailMessages.claimedAddress,
      claimedName: emailMessages.claimedName, senderTrust: emailMessages.senderTrust, connectionId: emailMessages.connectionId, contactName: contacts.fullName,
    }).from(emailMessages).leftJoin(contacts, eq(contacts.id, emailMessages.contactId))
      .where(and(eq(emailMessages.organizationId, ctx.orgId), inArray(emailMessages.id, ids))));
  const seen = new Set<string>();
  return letters.flatMap((m) => {
    const relay = m.senderTrust === "relay" && m.claimedAddress;
    const address = (draft.replyToMessageId ? draft.toAddresses[0] : relay ? m.claimedAddress! : m.fromAddress).toLowerCase();
    if (!wanted.has(address) || seen.has(address)) return [];
    seen.add(address);
    return [{ messageId: m.id, address, name: m.contactName ?? (relay ? m.claimedName : m.fromName), connectionId: m.connectionId ?? draft.connectionId }];
  });
}

const MAY_SEND = "Sending is for whoever approves replies, or the person who linked the mailbox.";
const MOST_COPIES = 500;

export async function sendReplyDraft(ctx: OfficeContext, draftId: string) {
  requirePermission(ctx, "communications.draft");
  const [draft] = await withTenant(tenantScope(ctx), async (tx) => {
    await assertMayAnswer(tx, ctx, draftId);
    return tx.select().from(emailDrafts).where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.organizationId, ctx.orgId)));
  });
  if (!draft) throw notFound("Draft not found.");
  if (draft.status !== "approved") {
    throw new AppError("validation", draft.status === "sending" ? "This reply is already going out." : "A reply is approved before it is sent.");
  }
  const people = await recipientsOf(ctx, draft);
  if (!people.length) throw new AppError("validation", "There is no one to send this to.");
  if (people.length > MOST_COPIES) throw new AppError("validation", `A reply can go to ${MOST_COPIES} people at a time.`);
  const mailboxes = new Map<string, Awaited<ReturnType<typeof getConnection>>>();
  for (const id of new Set(people.map((p) => p.connectionId))) {
    const conn = id
      ? await withTenant(tenantScope(ctx), (tx) =>
        tx.select().from(emailConnections).where(and(eq(emailConnections.id, id), eq(emailConnections.organizationId, ctx.orgId)))).then((r) => r[0])
      : undefined;
    if (!conn || !conn.sendEnabledAt || !mailboxCanSend(conn)) {
      throw new AppError(
        "validation",
        conn ? `Sending is not turned on for ${conn.emailAddress}. Turn it on in Settings, or send this reply from your own mail.`
          : "This letter did not come from a linked mailbox, so the reply goes out from your own mail.",
      );
    }
    if (!can(ctx, "communications.approve") && conn.authorizedBy !== ctx.userId) throw forbidden(MAY_SEND);
    mailboxes.set(conn.id, conn);
  }
  const deliveries = await withTenant(tenantScope(ctx), async (tx) => {
    // The first press takes it out of "approved", so pressing twice sends once.
    const [mine] = await tx.update(emailDrafts).set({ status: "sending", sentBy: ctx.userId })
      .where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.status, "approved"))).returning({ id: emailDrafts.id });
    if (!mine) throw new AppError("validation", "This reply is already going out.");
    await tx.insert(replyDeliveries)
      .values(people.map((p) => ({
        organizationId: ctx.orgId, draftId, messageId: p.messageId, connectionId: p.connectionId, toAddress: p.address, toName: p.name,
        rfcMessageId: newMessageId(mailboxes.get(p.connectionId!)!.emailAddress),
      })))
      .onConflictDoNothing();
    await tx.update(replyDeliveries).set({ status: "queued", error: null })
      .where(and(eq(replyDeliveries.draftId, draftId), eq(replyDeliveries.status, "failed")));
    await audit(tx, ctx, "reply.send_started", "email_draft", draftId, { people: people.length });
    return tx.select({ id: replyDeliveries.id }).from(replyDeliveries).where(and(eq(replyDeliveries.draftId, draftId), eq(replyDeliveries.status, "queued")));
  });
  if (deliveries.length === 1) {
    await deliverReply(ctx.orgId, deliveries[0].id);
    return { sent: 1, queued: 0 };
  }
  for (const d of deliveries) await enqueue("reply.deliver", { deliveryId: d.id }, { orgId: ctx.orgId, idempotencyKey: `deliver:${d.id}:${Date.now()}` });
  return { sent: 0, queued: deliveries.length };
}

// Marked as going out before the send, so a crash can never send it twice.
export async function deliverReply(orgId: string, deliveryId: string) {
  const claimed = await withTenant({ orgId }, async (tx) => {
    const [d] = await tx.select().from(replyDeliveries).where(and(eq(replyDeliveries.id, deliveryId), eq(replyDeliveries.organizationId, orgId)));
    if (!d || d.status === "sent") return null;
    const [draft] = await tx.select().from(emailDrafts).where(eq(emailDrafts.id, d.draftId));
    const stop = async (error: string) => {
      await tx.update(replyDeliveries).set({ status: "failed", error }).where(eq(replyDeliveries.id, d.id));
      return { stopped: error, draftId: d.draftId } as const;
    };
    if (d.status === "sending") return stop("This copy may already have gone out. Check the mailbox's Sent folder before sending it again.");
    if (!draft || draft.status !== "sending") return stop("The reply was changed before this copy went out.");
    const [letter] = d.messageId
      ? await tx.select({
        rfcMessageId: emailMessages.rfcMessageId, references: emailMessages.references, providerThreadId: emailThreads.providerThreadId,
        threadConnection: emailThreads.connectionId,
      }).from(emailMessages).leftJoin(emailThreads, eq(emailThreads.id, emailMessages.threadId)).where(eq(emailMessages.id, d.messageId))
      : [];
    const [org] = await tx.select({ name: organizations.name, legislatorName: organizations.legislatorName }).from(organizations)
      .where(eq(organizations.id, orgId));
    await tx.update(replyDeliveries).set({ status: "sending", attempts: d.attempts + 1 }).where(eq(replyDeliveries.id, d.id));
    return { d, draft, letter: letter ?? null, from: org.legislatorName ?? org.name };
  });
  if (!claimed) return "already" as const;
  if ("stopped" in claimed) {
    await settleDraft(orgId, claimed.draftId);
    throw new AppError("validation", claimed.stopped);
  }
  const { d, draft, letter, from } = claimed;
  try {
    const conn = d.connectionId ? await getConnection(orgId, d.connectionId) : null;
    if (!conn || !conn.sendEnabledAt || !mailboxCanSend(conn)) throw new AppError("validation", "Sending is turned off for this mailbox.");
    const sent = await sendFromMailbox(
      conn,
      {
        fromAddress: conn.emailAddress, fromName: from, to: { address: d.toAddress, name: d.toName }, subject: draft.subject, text: draft.bodyText,
        messageId: d.rfcMessageId, inReplyTo: letter?.rfcMessageId ?? null, references: (letter?.references ?? []).slice(-12),
      },
      { providerThreadId: letter && letter.threadConnection === conn.id ? letter.providerThreadId : null },
    );
    await withTenant({ orgId }, async (tx) => {
      await markDelivered(tx, orgId, d.id, d.draftId, d.messageId, new Date(), sent.providerMessageId);
      await audit(tx, systemContext(orgId), "reply.sent", "email_draft", d.draftId, { to: d.toAddress, from: conn.emailAddress });
    });
    return "sent" as const;
  } catch (e) {
    if (e instanceof RetryLaterError) {
      await withTenant({ orgId }, (tx) => tx.update(replyDeliveries).set({ status: "queued" }).where(eq(replyDeliveries.id, d.id)));
      throw e;
    }
    const reason = e instanceof AppError ? e.message : sendFailure(e);
    await withTenant({ orgId }, (tx) => tx.update(replyDeliveries).set({ status: "failed", error: reason }).where(eq(replyDeliveries.id, d.id)));
    await settleDraft(orgId, d.draftId);
    throw new AppError("validation", reason);
  }
}

async function settleDraft(orgId: string, draftId: string) {
  await withTenant({ orgId }, async (tx) => {
    const open = await tx.select({ id: replyDeliveries.id }).from(replyDeliveries)
      .where(and(eq(replyDeliveries.draftId, draftId), inArray(replyDeliveries.status, ["queued", "sending"]))).limit(1);
    if (!open.length) await tx.update(emailDrafts).set({ status: "approved" }).where(and(eq(emailDrafts.id, draftId), eq(emailDrafts.status, "sending")));
  });
}

export async function replyRoutes(ctx: OfficeContext, drafts: { id: string; connectionId: string | null }[]) {
  const ids = [...new Set(drafts.map((d) => d.connectionId).filter((x): x is string => Boolean(x)))];
  const mailboxes = ids.length
    ? await withTenant(tenantScope(ctx), (tx) =>
      tx.select().from(emailConnections).where(and(eq(emailConnections.organizationId, ctx.orgId), inArray(emailConnections.id, ids))))
    : [];
  const failed = drafts.length
    ? await withTenant(tenantScope(ctx), (tx) =>
      tx.select({ draftId: replyDeliveries.draftId, toAddress: replyDeliveries.toAddress, error: replyDeliveries.error }).from(replyDeliveries)
        .where(and(
          eq(replyDeliveries.organizationId, ctx.orgId), inArray(replyDeliveries.draftId, drafts.map((d) => d.id)), ne(replyDeliveries.status, "sent"),
        )))
    : [];
  return new Map(drafts.map((d) => {
    const m = mailboxes.find((x) => x.id === d.connectionId);
    const domain = m?.emailAddress.split("@")[1] ?? "";
    const opensIn = !m ? ("mail" as const)
      : m.provider === "microsoft" ? (/^(outlook|hotmail|live|msn)\./.test(domain) ? ("outlook_personal" as const) : ("outlook" as const))
        : m.provider === "google" || /^(gmail|googlemail)\.com$/.test(domain) ? ("gmail" as const) : ("mail" as const);
    const canSend = Boolean(m?.sendEnabledAt && mailboxCanSend(m) && (can(ctx, "communications.approve") || m.authorizedBy === ctx.userId));
    return [
      d.id,
      {
        from: m?.emailAddress ?? null, opensIn, canSend,
        problems: failed.filter((f) => f.draftId === d.id && f.error).map((f) => `${f.toAddress}: ${f.error}`),
      },
    ];
  }));
}

export async function listDrafts(ctx: OfficeContext) {
  requirePermission(ctx, "communications.draft");
  const rows = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      id: emailDrafts.id, subject: emailDrafts.subject, bodyText: emailDrafts.bodyText, toAddresses: emailDrafts.toAddresses, status: emailDrafts.status,
      aiGenerated: emailDrafts.aiGenerated, updatedAt: emailDrafts.updatedAt, approvedAt: emailDrafts.approvedAt, messageId: emailDrafts.replyToMessageId,
      connectionId: emailDrafts.connectionId, author: users.name, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
    }).from(emailDrafts).leftJoin(users, eq(users.id, emailDrafts.authorId)).leftJoin(emailMessages, eq(emailMessages.id, emailDrafts.replyToMessageId))
      .where(and(eq(emailDrafts.organizationId, ctx.orgId), inArray(emailDrafts.status, ["draft", "approved", "sending"]))).orderBy(desc(emailDrafts.updatedAt))
      .limit(100));
  return rows.map((r) => redactReply(ctx, r));
}

export async function listSentReplies(ctx: OfficeContext) {
  requirePermission(ctx, "communications.draft");
  return withTenant(tenantScope(ctx), async (tx) => {
    const rows = await tx.select({
      id: emailDrafts.id, subject: emailDrafts.subject, bodyText: emailDrafts.bodyText, toAddresses: emailDrafts.toAddresses, sentAt: emailDrafts.sentAt,
      approvedBy: emailDrafts.approvedBy, sentBy: emailDrafts.sentBy, sentVia: emailDrafts.sentVia, aiGenerated: emailDrafts.aiGenerated,
      messageId: emailDrafts.replyToMessageId, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
    }).from(emailDrafts).leftJoin(emailMessages, eq(emailMessages.id, emailDrafts.replyToMessageId))
      .where(and(eq(emailDrafts.organizationId, ctx.orgId), eq(emailDrafts.status, "sent"))).orderBy(desc(emailDrafts.sentAt)).limit(200);
    const ids = [...new Set(rows.flatMap((r) => [r.approvedBy, r.sentBy]).filter((x): x is string => Boolean(x)))];
    const people = ids.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
    const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
    return rows.map((r) => ({ ...redactReply(ctx, r), approvedByName: nameOf(r.approvedBy), sentByName: nameOf(r.sentBy) }));
  });
}
