import { and, asc, count, desc, eq, gte, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { withTenant } from "../db/client";
import {
  bills, caseMessages, cases, contacts, emailAttachments, emailDrafts, emailMessages, emailParticipants, issuePositions, issueTaxonomy, legislativeSessions,
  mailLedger, messageAsks, messageBillLinks, messageEvents, messageIssueLinks, messageNotes, reviewQueue, tasks, users, type MessageType,
} from "../db/schema";
import { can, requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { CATEGORY_TYPES, type StaffCategory } from "../classification/categories";
import { forbidden, notFound } from "../errors";
import { audit } from "./audit";
import { CAMPAIGNS, campaignPeople, districtIs, mayRead, type DistrictView } from "./center";

export const INBOX_FOLDERS = {
  all: "All mail", new: "New", urgent: "Urgent", held: "Sender not confirmed", mine: "Assigned to me", review: "Needs review", service: "Service requests",
  policy: "Policy correspondence", meeting: "Meeting requests", agency: "Agencies and organizations", automated: "Automated and newsletters", spam: "Spam",
  done: "Done", sent: "Sent",
} as const;
export type InboxFolder = keyof typeof INBOX_FOLDERS;

type InboxFilters = {
  folder?: InboxFolder; kind?: StaffCategory; district?: DistrictView; q?: string; issue?: string; bill?: string; from?: string; to?: string; assignee?: string;
  limit?: number; offset?: number;
};

const primaryType = sql`${emailMessages.messageTypes}[1]`;

function categoryCondition(kind: StaffCategory): SQL | undefined {
  if (kind === "internal") return or(eq(emailMessages.isInternal, true), sql`${primaryType} = 'legislative_staff'`);
  const known = Object.values(CATEGORY_TYPES).flat();
  if (kind === "uncertain") {
    return and(
      eq(emailMessages.isInternal, false),
      sql`coalesce(${primaryType}, 'other') not in (${sql.join([...known, "legislative_staff"].map((t) => sql`${t}`), sql`, `)})`,
    );
  }
  return and(eq(emailMessages.isInternal, false), sql`${primaryType} in (${sql.join(CATEGORY_TYPES[kind].map((t) => sql`${t}`), sql`, `)})`);
}

const isOfType = (...types: MessageType[]) =>
  or(...types.map((t) => sql`(${primaryType} = ${t} or coalesce((${emailMessages.messageTypeConfidence} ->> ${t})::float, 0) >= 0.8)`))!;

function folderCondition(folder: InboxFolder, ctx: OfficeContext): SQL | undefined {
  const inbound = eq(emailMessages.direction, "inbound");
  const notJunk = and(eq(emailMessages.isSpam, false), eq(emailMessages.isAutomated, false));
  switch (folder) {
    case "all":
      return and(inbound, notJunk, ne(emailMessages.triageStatus, "archived"));
    case "new":
      return and(inbound, notJunk, eq(emailMessages.triageStatus, "new"));
    case "urgent":
      return and(inbound, eq(emailMessages.priority, "urgent"), ne(emailMessages.triageStatus, "archived"));
    case "held":
      return and(inbound, inArray(emailMessages.senderTrust, ["failed", "unverified"]), ne(emailMessages.triageStatus, "archived"));
    case "mine":
      return and(inbound, eq(emailMessages.assignedTo, ctx.userId), ne(emailMessages.triageStatus, "done"));
    case "review":
      return and(inbound, eq(emailMessages.requiresReview, true), ne(emailMessages.triageStatus, "archived"));
    case "service":
      return and(inbound, notJunk, isOfType("constituent_service"));
    case "policy":
      return and(inbound, notJunk, isOfType("constituent_policy"));
    case "meeting":
      return and(inbound, notJunk, isOfType("meeting_request"));
    case "agency":
      return and(inbound, notJunk, isOfType("government_agency", "organization", "advocacy_lobbyist", "legislative_staff"));
    case "automated":
      return and(inbound, eq(emailMessages.isAutomated, true));
    case "spam":
      return and(inbound, eq(emailMessages.isSpam, true));
    case "done":
      return and(inbound, eq(emailMessages.triageStatus, "done"));
    case "sent":
      return eq(emailMessages.direction, "outbound");
  }
}

export async function listInbox(ctx: OfficeContext, f: InboxFilters) {
  requirePermission(ctx, "inbox.read");
  const limit = Math.min(f.limit ?? 50, 200);
  return withTenant(tenantScope(ctx), async (tx) => {
    const newslettersOnly = f.kind === "newsletter" && (f.folder ?? "all") === "all";
    const conds: (SQL | undefined)[] = [
      eq(emailMessages.organizationId, ctx.orgId),
      newslettersOnly ? and(eq(emailMessages.direction, "inbound"), eq(emailMessages.isAutomated, true)) : folderCondition(f.folder ?? "all", ctx),
    ];
    if (f.kind) conds.push(categoryCondition(f.kind));
    if (f.district) conds.push(districtIs(f.district));
    if (f.q?.trim()) conds.push(sql`${emailMessages.searchTsv} @@ websearch_to_tsquery('english', ${f.q.trim()})`);
    if (f.from) conds.push(gte(emailMessages.receivedAt, new Date(`${f.from}T00:00:00`)));
    if (f.to) conds.push(lte(emailMessages.receivedAt, new Date(`${f.to}T23:59:59`)));
    if (f.assignee) conds.push(eq(emailMessages.assignedTo, f.assignee));
    if (f.issue) {
      conds.push(
        sql`exists (select 1 from message_issue_links l where l.message_id = ${emailMessages.id} and l.status <> 'rejected' and (l.issue_key = ${f.issue} or l.issue_key like ${`${f.issue}.%`}))`,
      );
    }
    if (f.bill) conds.push(sql`exists (select 1 from message_bill_links l where l.message_id = ${emailMessages.id} and l.bill_id = ${f.bill})`);
    const where = and(...conds);
    const rows = await tx.select({
      id: emailMessages.id, threadId: emailMessages.threadId, subject: emailMessages.subject, fromAddress: emailMessages.fromAddress,
      fromName: emailMessages.fromName, snippet: emailMessages.snippet, summary: emailMessages.summary, receivedAt: emailMessages.receivedAt,
      direction: emailMessages.direction, isRead: emailMessages.isRead, triageStatus: emailMessages.triageStatus, priority: emailMessages.priority,
      requiresReview: emailMessages.requiresReview, isSensitive: emailMessages.isSensitive, messageTypes: emailMessages.messageTypes,
      processingStatus: emailMessages.processingStatus, hasAttachments: emailMessages.hasAttachments, templateClusterId: emailMessages.templateClusterId,
      formLetter: sql<boolean>`coalesce(${emailMessages.templateClusterId} in ${CAMPAIGNS}, false)`, senderTrust: emailMessages.senderTrust,
      personalNote: emailMessages.personalNote, urgencyReason: emailMessages.urgencyReason, assignedTo: emailMessages.assignedTo,
      isInternal: emailMessages.isInternal, districtStatus: contacts.districtStatus, assignedName: users.name,
    }).from(emailMessages).leftJoin(users, eq(users.id, emailMessages.assignedTo)).leftJoin(contacts, eq(contacts.id, emailMessages.contactId)).where(where)
      .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id)).limit(limit + 1).offset(f.offset ?? 0);
    const ids = rows.slice(0, limit).map((r) => r.id);
    const issueRows = ids.length
      ? await tx
          .select({ messageId: messageIssueLinks.messageId, key: messageIssueLinks.issueKey, status: messageIssueLinks.status, label: issueTaxonomy.label })
          .from(messageIssueLinks)
          .leftJoin(issueTaxonomy, and(eq(issueTaxonomy.organizationId, messageIssueLinks.organizationId), eq(issueTaxonomy.key, messageIssueLinks.issueKey)))
          .where(and(inArray(messageIssueLinks.messageId, ids), ne(messageIssueLinks.status, "rejected")))
      : [];
    const billRows = ids.length
      ? await tx.select({
        messageId: messageBillLinks.messageId, reference: messageBillLinks.reference, status: messageBillLinks.status, billId: messageBillLinks.billId,
      }).from(messageBillLinks).where(and(inArray(messageBillLinks.messageId, ids), ne(messageBillLinks.status, "rejected")))
      : [];
    const caseRows = ids.length
      ? await tx.select({ messageId: caseMessages.messageId, caseNumber: cases.caseNumber, status: cases.status }).from(caseMessages)
        .innerJoin(cases, eq(cases.id, caseMessages.caseId)).where(inArray(caseMessages.messageId, ids))
      : [];
    const [{ total }] = await tx.select({ total: count() }).from(emailMessages).where(where);
    return {
      total, hasMore: rows.length > limit,
      items: rows.slice(0, limit).map((r) => ({
        ...(mayRead(ctx, r) ? r
          : {
            ...r, subject: "Sensitive message", snippet: "", summary: "Your role cannot open this message.", personalNote: null,
            urgencyReason: r.urgencyReason ? "Sensitive" : null,
          }),
        issues: issueRows.filter((i) => i.messageId === r.id).map((i) => ({ key: i.key, label: i.label ?? i.key, suggested: i.status !== "confirmed" })),
        bills: billRows.filter((b) => b.messageId === r.id)
          .map((b) => ({ reference: b.reference, linked: Boolean(b.billId), suggested: b.status !== "confirmed" })),
        cases: caseRows.filter((c) => c.messageId === r.id),
      })),
    };
  });
}

export async function folderCounts(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const out = {} as Record<InboxFolder, number>;
    for (const key of Object.keys(INBOX_FOLDERS) as InboxFolder[]) {
      if (key === "all" || key === "done" || key === "sent") continue;
      const [{ n }] = await tx.select({ n: count() }).from(emailMessages)
        .where(and(
          eq(emailMessages.organizationId, ctx.orgId), folderCondition(key, ctx),
          key === "automated" || key === "spam" ? undefined : ne(emailMessages.triageStatus, "done"),
        ));
      out[key] = n;
    }
    return out;
  });
}

export async function listIssueOptions(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({ key: issueTaxonomy.key, label: issueTaxonomy.label, parentKey: issueTaxonomy.parentKey }).from(issueTaxonomy)
      .where(and(eq(issueTaxonomy.organizationId, ctx.orgId), eq(issueTaxonomy.isActive, true)))
      .orderBy(asc(issueTaxonomy.sortOrder), asc(issueTaxonomy.label)));
}

export async function getMessageDetail(ctx: OfficeContext, messageId: string) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [m] = await tx.select().from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, ctx.orgId)));
    if (!m) throw notFound("Message not found.");
    if (!mayRead(ctx, m)) throw forbidden("This message is restricted to staff who handle sensitive casework.");
    if (m.isSensitive) await audit(tx, ctx, "message.sensitive_read", "email_message", messageId);
    const thread = m.threadId
      ? await tx.select({
        id: emailMessages.id, fromName: emailMessages.fromName, fromAddress: emailMessages.fromAddress, sentAt: emailMessages.sentAt,
        direction: emailMessages.direction, substantiveText: emailMessages.substantiveText, subject: emailMessages.subject,
        isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
      }).from(emailMessages).where(and(eq(emailMessages.organizationId, ctx.orgId), eq(emailMessages.threadId, m.threadId))).orderBy(asc(emailMessages.sentAt))
        .limit(40)
      : [];
    const participants = await tx.select().from(emailParticipants).where(eq(emailParticipants.messageId, messageId));
    const attachments = await tx.select().from(emailAttachments).where(eq(emailAttachments.messageId, messageId));
    const issues = await tx.select({
      id: messageIssueLinks.id, key: messageIssueLinks.issueKey, label: issueTaxonomy.label, parentKey: issueTaxonomy.parentKey,
      confidence: messageIssueLinks.confidence, source: messageIssueLinks.source, status: messageIssueLinks.status, evidence: messageIssueLinks.evidence,
    }).from(messageIssueLinks)
      .leftJoin(issueTaxonomy, and(eq(issueTaxonomy.organizationId, messageIssueLinks.organizationId), eq(issueTaxonomy.key, messageIssueLinks.issueKey)))
      .where(eq(messageIssueLinks.messageId, messageId));
    const billLinks = await tx.select().from(messageBillLinks).where(eq(messageBillLinks.messageId, messageId));
    const candidateIds = [...new Set(billLinks.flatMap((b) => [...b.candidateBillIds, ...(b.billId ? [b.billId] : [])]))];
    const billInfo = candidateIds.length
      ? await tx.select({
        id: bills.id, identifier: bills.identifier, title: bills.title, status: bills.status, session: legislativeSessions.identifier,
        jurisdiction: bills.jurisdictionCode,
      }).from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId)).where(inArray(bills.id, candidateIds))
      : [];
    const positions = await tx.select().from(issuePositions).where(eq(issuePositions.messageId, messageId));
    const contact = m.contactId ? (await tx.select().from(contacts).where(eq(contacts.id, m.contactId)))[0] ?? null : null;
    const previous = m.contactId
      ? await tx.select({
        id: emailMessages.id, subject: emailMessages.subject, sentAt: emailMessages.sentAt, direction: emailMessages.direction, summary: emailMessages.summary,
        isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
      }).from(emailMessages)
        .where(and(
          eq(emailMessages.contactId, m.contactId), ne(emailMessages.id, messageId),
          or(sql`${emailMessages.threadId} is null`, m.threadId ? ne(emailMessages.threadId, m.threadId) : sql`true`),
        ))
        .orderBy(desc(emailMessages.sentAt)).limit(8)
      : [];
    const notes = await tx.select({ id: messageNotes.id, body: messageNotes.body, createdAt: messageNotes.createdAt, author: users.name }).from(messageNotes)
      .leftJoin(users, eq(users.id, messageNotes.authorId)).where(eq(messageNotes.messageId, messageId)).orderBy(asc(messageNotes.createdAt));
    const events = await tx.select({
      id: messageEvents.id, type: messageEvents.type, data: messageEvents.data, createdAt: messageEvents.createdAt, actor: users.name,
    }).from(messageEvents).leftJoin(users, eq(users.id, messageEvents.actorId)).where(eq(messageEvents.messageId, messageId))
      .orderBy(desc(messageEvents.createdAt)).limit(30);
    const linkedCases = await tx.select({
      id: cases.id, caseNumber: cases.caseNumber, title: cases.title, status: cases.status, isSensitive: cases.isSensitive,
    }).from(caseMessages).innerJoin(cases, eq(cases.id, caseMessages.caseId)).where(eq(caseMessages.messageId, messageId));
    const reviews = await tx.select().from(reviewQueue).where(and(eq(reviewQueue.messageId, messageId), eq(reviewQueue.status, "open")));
    const asks = await tx.select().from(messageAsks).where(eq(messageAsks.messageId, messageId)).orderBy(asc(messageAsks.quoteStart));
    const [ledger] = await tx.select().from(mailLedger).where(and(eq(mailLedger.organizationId, ctx.orgId), eq(mailLedger.messageId, messageId)))
      .orderBy(asc(mailLedger.createdAt)).limit(1);
    const people = m.templateClusterId ? await campaignPeople(tx, m.templateClusterId) : 0;
    const drafts = await tx.select().from(emailDrafts).where(and(eq(emailDrafts.replyToMessageId, messageId), ne(emailDrafts.status, "discarded")))
      .orderBy(desc(emailDrafts.updatedAt));
    const suggestedTasks = await tx.select().from(tasks).where(eq(tasks.messageId, messageId));
    const assignee = m.assignedTo ? (await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, m.assignedTo)))[0] ?? null : null;
    return {
      message: m,
      thread: thread.filter((t) => t.id !== m.id)
        .map((t) => (mayRead(ctx, t) ? { ...t, restricted: false } : { ...t, substantiveText: "", subject: "Sensitive message", restricted: true })),
      participants, attachments, issues,
      billLinks: billLinks.map((b) => ({
        ...b, bill: billInfo.find((x) => x.id === b.billId) ?? null, candidates: billInfo.filter((x) => b.candidateBillIds.includes(x.id)),
      })),
      positions, contact,
      previous: previous.map((p) => (mayRead(ctx, p) ? p : { ...p, subject: "Sensitive message", summary: "Your role cannot open this message." })), notes,
      events, cases: linkedCases.filter((c) => !c.isSensitive || can(ctx, "cases.read_sensitive")), reviews, asks, ledger: ledger ?? null,
      formLetter: people >= 2 ? { id: m.templateClusterId!, people } : null, drafts, tasks: suggestedTasks, assignee,
    };
  });
}
