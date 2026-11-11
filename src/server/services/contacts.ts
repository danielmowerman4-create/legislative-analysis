import { and, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { withTenant } from "../db/client";
import {
  cases, contactAddresses, contactCommunicationPreferences, contactEmails, contactMergeHistory, contactNotes, contacts, emailMessages, issuePositions,
  issueTaxonomy, messageIssueLinks, tasks, users, type ContactKind,
} from "../db/schema";
import { can, requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, notFound } from "../errors";
import { mayRead } from "./center";

export async function listContacts(
  ctx: OfficeContext, f: { q?: string; kind?: string; issue?: string; district?: "in" | "outside" | "unknown"; limit?: number; offset?: number },
) {
  requirePermission(ctx, "contacts.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const conds: (SQL | undefined)[] = [eq(contacts.organizationId, ctx.orgId), isNull(contacts.mergedIntoId)];
    if (f.kind) conds.push(eq(contacts.kind, f.kind as ContactKind));
    else conds.push(sql`${contacts.kind} in ('person','unknown','organization')`);
    if (f.q?.trim()) {
      const q = f.q.trim();
      conds.push(or(
        sql`${contacts.searchTsv} @@ plainto_tsquery('simple', ${q})`, ilike(contacts.fullName, `%${q}%`),
        sql`${contacts.id} in (select e.contact_id from contact_emails e where e.organization_id = ${ctx.orgId} and e.email ilike ${`%${q}%`})`,
      ));
    }
    if (f.issue) {
      conds.push(
        sql`exists (select 1 from email_messages m join message_issue_links l on l.message_id = m.id where m.contact_id = ${contacts.id} and l.status <> 'rejected' and (l.issue_key = ${f.issue} or l.issue_key like ${`${f.issue}.%`}))`,
      );
    }
    if (f.district === "in") conds.push(eq(contacts.districtStatus, "in_district"));
    else if (f.district === "outside") conds.push(sql`${contacts.districtStatus} in ('outside', 'out_of_state')`);
    else if (f.district === "unknown") conds.push(isNull(contacts.districtStatus));
    const where = and(...conds);
    const limit = Math.min(f.limit ?? 50, 200);
    const rows = await tx.select({
      id: contacts.id, fullName: contacts.fullName, districtStatus: contacts.districtStatus, organizationName: contacts.organizationName, kind: contacts.kind,
      municipality: contacts.municipality, district: contacts.district, lastContactAt: contacts.lastContactAt,
      email: sql<string | null>`(select e.email from contact_emails e where e.contact_id = contacts.id order by e.is_primary desc limit 1)`,
      messages: sql<number>`(select count(*)::int from email_messages m where m.contact_id = contacts.id and m.direction = 'inbound')`,
      openCases: sql<number>`(select count(*)::int from cases c where c.contact_id = contacts.id and c.status not in ('resolved','closed'))`,
    }).from(contacts).where(where).orderBy(desc(sql`coalesce(${contacts.lastContactAt}, ${contacts.createdAt})`)).limit(limit + 1).offset(f.offset ?? 0);
    const [{ total }] = await tx.select({ total: count() }).from(contacts).where(where);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit, total };
  });
}

type TimelineItem = { at: Date; kind: "email_in" | "email_out" | "case" | "note" | "task"; id: string; title: string; detail: string | null; href: string };

export async function getContactDetail(ctx: OfficeContext, contactId: string) {
  requirePermission(ctx, "contacts.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [c] = await tx.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.orgId)));
    if (!c) throw notFound("Constituent not found.");
    const emails = await tx.select().from(contactEmails).where(eq(contactEmails.contactId, contactId)).orderBy(desc(contactEmails.isPrimary));
    const addresses = await tx.select().from(contactAddresses).where(eq(contactAddresses.contactId, contactId));
    const prefs = await tx.select().from(contactCommunicationPreferences).where(eq(contactCommunicationPreferences.contactId, contactId));
    const messages = await tx.select({
      id: emailMessages.id, subject: emailMessages.subject, sentAt: emailMessages.sentAt, direction: emailMessages.direction, summary: emailMessages.summary,
      messageTypes: emailMessages.messageTypes, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
    }).from(emailMessages).where(and(eq(emailMessages.contactId, contactId), eq(emailMessages.organizationId, ctx.orgId))).orderBy(desc(emailMessages.sentAt))
      .limit(300);
    const caseRows = can(ctx, "cases.read")
      ? await tx.select({
        id: cases.id, caseNumber: cases.caseNumber, title: cases.title, status: cases.status, createdAt: cases.createdAt, isSensitive: cases.isSensitive,
        assignedTo: cases.assignedTo,
      }).from(cases).where(eq(cases.contactId, contactId)).orderBy(desc(cases.createdAt))
      : [];
    const visibleCases = caseRows.filter((x) => !x.isSensitive || can(ctx, "cases.read_sensitive") || x.assignedTo === ctx.userId);
    const notes = await tx.select({
      id: contactNotes.id, body: contactNotes.body, visibility: contactNotes.visibility, createdAt: contactNotes.createdAt, author: users.name,
    }).from(contactNotes).leftJoin(users, eq(users.id, contactNotes.authorId)).where(eq(contactNotes.contactId, contactId))
      .orderBy(desc(contactNotes.createdAt));
    const issues = await tx.select({
      key: messageIssueLinks.issueKey, label: issueTaxonomy.label, n: sql<number>`count(distinct ${messageIssueLinks.messageId})::int`,
    }).from(messageIssueLinks).innerJoin(emailMessages, eq(emailMessages.id, messageIssueLinks.messageId))
      .leftJoin(issueTaxonomy, and(eq(issueTaxonomy.organizationId, messageIssueLinks.organizationId), eq(issueTaxonomy.key, messageIssueLinks.issueKey)))
      .where(and(eq(emailMessages.contactId, contactId), sql`${messageIssueLinks.status} <> 'rejected'`))
      .groupBy(messageIssueLinks.issueKey, issueTaxonomy.label).orderBy(desc(sql`count(distinct ${messageIssueLinks.messageId})`));
    const positions = await tx.select({
      targetKey: issuePositions.targetKey, position: issuePositions.position, status: issuePositions.status, messageId: issuePositions.messageId,
      createdAt: issuePositions.createdAt,
    }).from(issuePositions)
      .where(and(eq(issuePositions.contactId, contactId), sql`${issuePositions.status} <> 'rejected'`, sql`${issuePositions.position} <> 'unclear'`))
      .orderBy(desc(issuePositions.createdAt));
    const openTasks = await tx.select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt, status: tasks.status, createdAt: tasks.createdAt }).from(tasks)
      .innerJoin(emailMessages, eq(emailMessages.id, tasks.messageId)).where(eq(emailMessages.contactId, contactId));
    const merges = await tx.select().from(contactMergeHistory)
      .where(or(eq(contactMergeHistory.survivorId, contactId), eq(contactMergeHistory.mergedId, contactId)));

    const timeline: TimelineItem[] = [
      ...messages.map((m) => ({
        at: m.sentAt, kind: (m.direction === "inbound" ? "email_in" : "email_out") as TimelineItem["kind"], id: m.id,
        ...(mayRead(ctx, m) ? { title: m.subject || "(no subject)", detail: m.summary }
          : { title: "Sensitive message", detail: "Your role cannot open this message." }),
        href: `/constituent-center/mail/${m.id}`,
      })),
      ...visibleCases.map((x) => ({
        at: x.createdAt, kind: "case" as const, id: x.id, title: `${x.caseNumber} ${x.title}`, detail: x.status.replace(/_/g, " "),
        href: `/constituent-center/casework/${x.id}`,
      })),
      ...notes.map((n) => ({
        at: n.createdAt, kind: "note" as const, id: n.id, title: `Note by ${n.author ?? "staff"}${n.visibility === "private" ? " (private)" : ""}`,
        detail: n.body, href: `/constituent-center/people/${contactId}#note-${n.id}`,
      })),
      ...openTasks.map((t) => ({ at: t.createdAt, kind: "task" as const, id: t.id, title: t.title, detail: t.status, href: `/constituent-center` })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    return {
      contact: c, emails, addresses, prefs, cases: visibleCases, notes, issues, positions, timeline, merges,
      messageCount: messages.filter((m) => m.direction === "inbound").length,
    };
  });
}

export async function addContactNote(ctx: OfficeContext, contactId: string, body: string, visibility: "office" | "private") {
  requirePermission(ctx, "contacts.write");
  if (!body.trim()) throw new AppError("validation", "Note is empty.");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [c] = await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.organizationId, ctx.orgId)));
    if (!c) throw notFound("Person not found.");
    await tx.insert(contactNotes).values({ organizationId: ctx.orgId, contactId, authorId: ctx.userId, body: body.trim().slice(0, 10_000), visibility });
  });
}
