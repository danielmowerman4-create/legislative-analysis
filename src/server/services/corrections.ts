import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import {
  bills, classificationFeedback, emailMessages, issuePositions, issueTaxonomy, memberships, messageBillLinks, messageEvents, messageIssueLinks, messageNotes,
  reviewQueue, type Position,
} from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, forbidden, notFound } from "../errors";
import { audit } from "./audit";
import { mayRead } from "./center";
import { MESSAGE_TYPES, type MessageTypeKey } from "../classification/schema";

// Changing a letter needs the right to read it; assigning one to yourself would otherwise open it.
async function assertMessage(tx: Db, ctx: OfficeContext, messageId: string) {
  const [m] = await tx
    .select({ id: emailMessages.id, contactId: emailMessages.contactId, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo })
    .from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, ctx.orgId)));
  if (!m) throw notFound("Message not found.");
  if (!mayRead(ctx, m)) throw forbidden("This message is restricted to staff who handle sensitive casework.");
  return m;
}

async function record(
  tx: Db, ctx: OfficeContext, messageId: string, field: (typeof classificationFeedback.$inferInsert)["field"], targetKey: string | null, before: unknown,
  after: unknown, note?: string,
) {
  await tx.insert(classificationFeedback).values({ organizationId: ctx.orgId, messageId, field, targetKey, before, after, actorId: ctx.userId, note });
  await tx.insert(messageEvents).values({
    organizationId: ctx.orgId, messageId, actorId: ctx.userId, type: `${field}_corrected`, data: { targetKey, before, after } as Record<string, unknown>,
  });
  await audit(tx, ctx, `classification.${field}.corrected`, "email_message", messageId, { targetKey, before, after } as Record<string, unknown>);
}

async function resolveReviews(tx: Db, ctx: OfficeContext, where: ReturnType<typeof and>, resolution: string) {
  await tx.update(reviewQueue).set({ status: "resolved", resolvedBy: ctx.userId, resolvedAt: new Date(), resolution })
    .where(and(eq(reviewQueue.organizationId, ctx.orgId), eq(reviewQueue.status, "open"), where));
}

export async function refreshRequiresReview(tx: Db, messageId: string) {
  await tx.update(emailMessages).set({ requiresReview: sql`exists (select 1 from review_queue r where r.message_id = ${messageId} and r.status = 'open')` })
    .where(eq(emailMessages.id, messageId));
}

export async function setIssueLabel(ctx: OfficeContext, messageId: string, issueKey: string, decision: "confirm" | "reject") {
  requirePermission(ctx, "inbox.triage");
  return withTenant(tenantScope(ctx), async (tx) => {
    await assertMessage(tx, ctx, messageId);
    const [node] = await tx.select({ key: issueTaxonomy.key }).from(issueTaxonomy)
      .where(and(eq(issueTaxonomy.organizationId, ctx.orgId), eq(issueTaxonomy.key, issueKey), eq(issueTaxonomy.isActive, true)));
    if (!node) throw new AppError("validation", "That issue is not in the office taxonomy.");
    const [existing] = await tx.select().from(messageIssueLinks)
      .where(and(eq(messageIssueLinks.messageId, messageId), eq(messageIssueLinks.issueKey, issueKey)));
    const status = decision === "confirm" ? "confirmed" : "rejected";
    const values = { source: "staff" as const, status: status as "confirmed" | "rejected", decidedBy: ctx.userId, decidedAt: new Date() };
    if (existing) await tx.update(messageIssueLinks).set(values).where(eq(messageIssueLinks.id, existing.id));
    else await tx.insert(messageIssueLinks).values({ organizationId: ctx.orgId, messageId, issueKey, confidence: 1, evidence: [], ...values });
    if (existing) await resolveReviews(tx, ctx, and(eq(reviewQueue.entityType, "message_issue_link"), eq(reviewQueue.entityId, existing.id)), status);
    if (decision === "reject") {
      await tx.update(issuePositions).set({ ...values, status: "rejected" })
        .where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, `issue:${issueKey}`)));
    }
    await record(tx, ctx, messageId, "issue", issueKey, existing ? { status: existing.status, source: existing.source } : null, { status });
    await refreshRequiresReview(tx, messageId);
  });
}

export async function setBillLink(ctx: OfficeContext, messageId: string, reference: string, billId: string | null) {
  requirePermission(ctx, "inbox.triage");
  return withTenant(tenantScope(ctx), async (tx) => {
    await assertMessage(tx, ctx, messageId);
    let known: { id: string; identifier: string } | undefined;
    if (billId) {
      [known] = await tx.select({ id: bills.id, identifier: bills.identifier }).from(bills).where(eq(bills.id, billId));
      if (!known) throw new AppError("validation", "Unknown bill.");
    }
    const [existing] = await tx.select().from(messageBillLinks)
      .where(and(eq(messageBillLinks.messageId, messageId), eq(messageBillLinks.reference, reference)));
    const finalReference = known?.identifier ?? reference;
    if (finalReference !== reference) {
      const [twin] = await tx.select({ id: messageBillLinks.id }).from(messageBillLinks)
        .where(and(eq(messageBillLinks.messageId, messageId), eq(messageBillLinks.reference, finalReference)));
      if (twin && existing) {
        await resolveReviews(tx, ctx, and(eq(reviewQueue.entityType, "message_bill_link"), eq(reviewQueue.entityId, twin.id)), "merged");
        await tx.delete(messageBillLinks).where(eq(messageBillLinks.id, twin.id));
      }
      const [held] = await tx.select({ id: issuePositions.id }).from(issuePositions)
        .where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, `bill:${finalReference}`)));
      if (held) {
        await tx.delete(issuePositions).where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, `bill:${reference}`)));
      } else {
        await tx.update(issuePositions).set({ targetKey: `bill:${finalReference}`, billReference: finalReference })
          .where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, `bill:${reference}`)));
      }
    }
    const values = {
      billId, reference: finalReference, source: "staff" as const, status: (billId ? "confirmed" : "rejected") as "confirmed" | "rejected",
      decidedBy: ctx.userId, decidedAt: new Date(), resolution: (billId ? "resolved" : "unmatched") as "resolved" | "unmatched",
    };
    if (existing) await tx.update(messageBillLinks).set(values).where(eq(messageBillLinks.id, existing.id));
    else await tx.insert(messageBillLinks).values({ organizationId: ctx.orgId, messageId, rawReference: reference, confidence: 1, evidence: [], ...values });
    if (existing) {
      await resolveReviews(
        tx, ctx, and(eq(reviewQueue.entityType, "message_bill_link"), eq(reviewQueue.entityId, existing.id)), billId ? "linked" : "rejected",
      );
    }
    await tx.update(issuePositions).set({ billId }).where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, `bill:${finalReference}`)));
    await record(tx, ctx, messageId, "bill", reference, existing ? { billId: existing.billId, status: existing.status } : null, { billId });
    await refreshRequiresReview(tx, messageId);
  });
}

export async function setPosition(ctx: OfficeContext, messageId: string, targetKey: string, position: Position) {
  requirePermission(ctx, "inbox.triage");
  if (!/^(issue|bill):.+/.test(targetKey)) throw new AppError("validation", "Invalid target.");
  return withTenant(tenantScope(ctx), async (tx) => {
    const m = await assertMessage(tx, ctx, messageId);
    const [existing] = await tx.select().from(issuePositions).where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.targetKey, targetKey)));
    const isBill = targetKey.startsWith("bill:");
    const ref = targetKey.slice(isBill ? 5 : 6);
    const [billLink] = isBill
      ? await tx.select({ billId: messageBillLinks.billId }).from(messageBillLinks)
        .where(and(eq(messageBillLinks.messageId, messageId), eq(messageBillLinks.reference, ref)))
      : [];
    const values = { position, source: "staff" as const, status: "confirmed" as const, decidedBy: ctx.userId, decidedAt: new Date(), confidence: 1 };
    if (existing) {
      await tx.update(issuePositions).set(values).where(eq(issuePositions.id, existing.id));
    } else {
      await tx.insert(issuePositions).values({
        organizationId: ctx.orgId, messageId, contactId: m.contactId, targetKey, targetType: isBill ? "bill" : "issue", issueKey: isBill ? null : ref,
        billReference: isBill ? ref : null, billId: billLink?.billId ?? null, evidence: [], ...values,
      });
    }
    if (existing) await resolveReviews(tx, ctx, and(eq(reviewQueue.entityType, "issue_position"), eq(reviewQueue.entityId, existing.id)), position);
    await record(tx, ctx, messageId, "position", targetKey, existing ? { position: existing.position, source: existing.source } : null, { position });
    await refreshRequiresReview(tx, messageId);
  });
}

export async function setMessageTypes(ctx: OfficeContext, messageId: string, types: MessageTypeKey[]) {
  requirePermission(ctx, "inbox.triage");
  const clean = types.filter((t) => (MESSAGE_TYPES as readonly string[]).includes(t));
  if (!clean.length) throw new AppError("validation", "Choose at least one type.");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [before] = await tx.select({ types: emailMessages.messageTypes }).from(emailMessages)
      .where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, ctx.orgId)));
    if (!before) throw notFound();
    await tx.update(emailMessages)
      .set({
        messageTypes: clean, messageTypeConfidence: Object.fromEntries(clean.map((t) => [t, 1])), isSpam: clean.includes("spam"),
        isAutomated: clean.includes("newsletter_automated"),
        includeOverride: clean.some((t) => t === "constituent_policy" || t === "constituent_service" || t === "constituent_general"),
      })
      .where(eq(emailMessages.id, messageId));
    await resolveReviews(tx, ctx, and(eq(reviewQueue.messageId, messageId), eq(reviewQueue.kind, "message_type")), clean.join(","));
    await record(tx, ctx, messageId, "message_type", null, before.types, clean);
    await refreshRequiresReview(tx, messageId);
  });
}

export async function assignMessage(ctx: OfficeContext, messageId: string, assigneeId: string | null) {
  requirePermission(ctx, "inbox.triage");
  return withTenant(tenantScope(ctx), async (tx) => {
    await assertMessage(tx, ctx, messageId);
    if (assigneeId) {
      const [m] = await tx.select({ id: memberships.id }).from(memberships)
        .where(and(eq(memberships.organizationId, ctx.orgId), eq(memberships.userId, assigneeId), eq(memberships.status, "active")));
      if (!m) throw new AppError("validation", "That person is not on this office's staff.");
    }
    await tx.update(emailMessages)
      .set({
        assignedTo: assigneeId, triageStatus: sql`case when ${emailMessages.triageStatus} = 'new' then 'in_progress' else ${emailMessages.triageStatus} end`,
      })
      .where(eq(emailMessages.id, messageId));
    await tx.insert(messageEvents).values({ organizationId: ctx.orgId, messageId, actorId: ctx.userId, type: "assigned", data: { assigneeId } });
    await audit(tx, ctx, "message.assigned", "email_message", messageId, { assigneeId });
  });
}

export async function setTriageStatus(ctx: OfficeContext, messageIds: string[], status: "new" | "in_progress" | "done" | "archived") {
  requirePermission(ctx, "inbox.triage");
  if (!messageIds.length) return;
  return withTenant(tenantScope(ctx), async (tx) => {
    const changed = await tx.update(emailMessages).set({ triageStatus: status })
      .where(and(eq(emailMessages.organizationId, ctx.orgId), inArray(emailMessages.id, messageIds))).returning({ id: emailMessages.id });
    if (!changed.length) return;
    await tx.insert(messageEvents)
      .values(changed.map(({ id }) => ({ organizationId: ctx.orgId, messageId: id, actorId: ctx.userId, type: "status_changed", data: { status } })));
  });
}

export async function addMessageNote(ctx: OfficeContext, messageId: string, body: string) {
  requirePermission(ctx, "inbox.triage");
  const text = body.trim();
  if (!text) throw new AppError("validation", "Note is empty.");
  return withTenant(tenantScope(ctx), async (tx) => {
    await assertMessage(tx, ctx, messageId);
    const [n] = await tx.insert(messageNotes).values({ organizationId: ctx.orgId, messageId, authorId: ctx.userId, body: text.slice(0, 5000) }).returning();
    await tx.insert(messageEvents).values({ organizationId: ctx.orgId, messageId, actorId: ctx.userId, type: "note_added", data: {} });
    return n;
  });
}
