import { and, asc, count, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import {
  agencyDirectory, caseAssignments, caseEvents, caseMessages, cases, contacts, emailMessages, memberships, reviewQueue, tasks, users, type CasePriority,
  type CaseStatus,
} from "../db/schema";
import { can, requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, forbidden, notFound } from "../errors";
import { audit } from "./audit";

export const CASE_STATUSES: Record<CaseStatus, string> = {
  new: "New", under_review: "Under review", awaiting_constituent: "Awaiting constituent", awaiting_agency: "Awaiting agency", resolved: "Resolved",
  closed: "Closed",
};

function visibility(ctx: OfficeContext): SQL | undefined {
  if (can(ctx, "cases.read_sensitive")) return undefined;
  return or(eq(cases.isSensitive, false), eq(cases.assignedTo, ctx.userId));
}

async function nextCaseNumber(tx: Db, orgId: string) {
  const year = new Date().getFullYear();
  const res = await tx.execute<{ last_number: number }>(sql`
    insert into case_counters (organization_id, year, last_number) values (${orgId}, ${year}, 1)
    on conflict (organization_id, year) do update set last_number = case_counters.last_number + 1
    returning last_number`);
  return `C-${year}-${String(res.rows[0].last_number).padStart(4, "0")}`;
}

async function assertStaff(tx: Db, orgId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = await tx.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId), eq(memberships.status, "active")));
  if (!m) throw new AppError("validation", "Assignee is not on this office's staff.");
}

// Anything named on a case must belong to this office.
async function assertOwn(tx: Db, orgId: string, ids: { agencyId?: string | null; contactId?: string | null }) {
  if (ids.agencyId &&
    !(await tx.select({ id: agencyDirectory.id }).from(agencyDirectory)
      .where(and(eq(agencyDirectory.organizationId, orgId), eq(agencyDirectory.id, ids.agencyId)))).length) {
    throw new AppError("validation", "That agency is not on this office's list.");
  }
  if (ids.contactId &&
    !(await tx.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.organizationId, orgId), eq(contacts.id, ids.contactId)))).length) {
    throw new AppError("validation", "That person is not in this office's records.");
  }
}

export type CreateCaseInput = {
  title: string; category: string; description?: string; contactId?: string | null; agencyId?: string | null; priority?: CasePriority;
  assignedTo?: string | null; followUpAt?: string | null; sourceMessageId?: string | null; isSensitive?: boolean;
};

export async function createCase(ctx: OfficeContext, input: CreateCaseInput) {
  requirePermission(ctx, "cases.write");
  if (!input.title.trim()) throw new AppError("validation", "Case title is required.");
  return withTenant(tenantScope(ctx), async (tx) => {
    await assertStaff(tx, ctx.orgId, input.assignedTo);
    await assertOwn(tx, ctx.orgId, input);
    let contactId = input.contactId ?? null;
    let sensitive = input.isSensitive ?? false;
    if (input.sourceMessageId) {
      const [m] = await tx.select({ contactId: emailMessages.contactId, isSensitive: emailMessages.isSensitive }).from(emailMessages)
        .where(and(eq(emailMessages.id, input.sourceMessageId), eq(emailMessages.organizationId, ctx.orgId)));
      if (!m) throw notFound("Source message not found.");
      contactId ??= m.contactId;
      sensitive ||= m.isSensitive;
    }
    const caseNumber = await nextCaseNumber(tx, ctx.orgId);
    const [c] = await tx.insert(cases)
      .values({
        organizationId: ctx.orgId, caseNumber, contactId, title: input.title.trim().slice(0, 200), category: input.category,
        description: input.description?.trim() ?? "", priority: input.priority ?? "normal", assignedTo: input.assignedTo ?? null, createdBy: ctx.userId,
        agencyId: input.agencyId ?? null, isSensitive: sensitive, consentStatus: sensitive ? "required" : "not_required",
        followUpAt: input.followUpAt ? new Date(input.followUpAt) : null, sourceMessageId: input.sourceMessageId ?? null,
        status: input.assignedTo ? "under_review" : "new",
      })
      .returning();
    await tx.insert(caseEvents)
      .values({ organizationId: ctx.orgId, caseId: c.id, actorId: ctx.userId, type: "created", data: { source: input.sourceMessageId ? "email" : "manual" } });
    if (input.assignedTo) {
      await tx.insert(caseAssignments).values({ organizationId: ctx.orgId, caseId: c.id, userId: input.assignedTo, assignedBy: ctx.userId });
      await tx.insert(caseEvents)
        .values({ organizationId: ctx.orgId, caseId: c.id, actorId: ctx.userId, type: "assigned", data: { userId: input.assignedTo } });
    }
    if (input.sourceMessageId) {
      await tx.insert(caseMessages).values({ organizationId: ctx.orgId, caseId: c.id, messageId: input.sourceMessageId, linkedBy: ctx.userId })
        .onConflictDoNothing();
      await tx.update(reviewQueue).set({ status: "resolved", resolvedBy: ctx.userId, resolvedAt: new Date(), resolution: `case ${caseNumber}` })
        .where(and(
          eq(reviewQueue.organizationId, ctx.orgId), eq(reviewQueue.messageId, input.sourceMessageId), eq(reviewQueue.kind, "case_suggestion"),
          eq(reviewQueue.status, "open"),
        ));
      await tx.update(emailMessages)
        .set({
          triageStatus: "in_progress",
          requiresReview: sql`exists (select 1 from review_queue r where r.message_id = ${input.sourceMessageId} and r.status = 'open')`,
        })
        .where(eq(emailMessages.id, input.sourceMessageId));
    }
    await audit(tx, ctx, "case.created", "case", c.id, { caseNumber, sensitive });
    return c;
  });
}

export async function listCases(
  ctx: OfficeContext,
  f: { status?: string; assignee?: string; overdue?: boolean; agency?: string; category?: string; q?: string; limit?: number; offset?: number },
) {
  requirePermission(ctx, "cases.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const conds: (SQL | undefined)[] = [eq(cases.organizationId, ctx.orgId), visibility(ctx)];
    if (f.status === "open") conds.push(sql`${cases.status} not in ('resolved','closed')`);
    else if (f.status) conds.push(eq(cases.status, f.status as CaseStatus));
    if (f.assignee === "me") conds.push(eq(cases.assignedTo, ctx.userId));
    else if (f.assignee === "none") conds.push(sql`${cases.assignedTo} is null`);
    else if (f.assignee) conds.push(eq(cases.assignedTo, f.assignee));
    if (f.overdue) conds.push(and(lt(cases.followUpAt, new Date()), sql`${cases.status} not in ('resolved','closed')`));
    if (f.agency) conds.push(eq(cases.agencyId, f.agency));
    if (f.category) conds.push(eq(cases.category, f.category));
    if (f.q?.trim()) conds.push(sql`(${cases.searchTsv} @@ websearch_to_tsquery('english', ${f.q.trim()}) or ${cases.caseNumber} ilike ${f.q.trim()})`);
    const where = and(...conds);
    const limit = Math.min(f.limit ?? 50, 200);
    const rows = await tx.select({
      id: cases.id, caseNumber: cases.caseNumber, title: cases.title, category: cases.category, status: cases.status, priority: cases.priority,
      isSensitive: cases.isSensitive, followUpAt: cases.followUpAt, lastActivityAt: cases.lastActivityAt, createdAt: cases.createdAt,
      contactName: contacts.fullName, contactId: cases.contactId, agency: agencyDirectory.abbreviation, agencyName: agencyDirectory.name, assignee: users.name,
    }).from(cases).leftJoin(contacts, eq(contacts.id, cases.contactId)).leftJoin(agencyDirectory, eq(agencyDirectory.id, cases.agencyId))
      .leftJoin(users, eq(users.id, cases.assignedTo)).where(where)
      .orderBy(
        sql`case ${cases.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, asc(cases.followUpAt), desc(cases.lastActivityAt),
      )
      .limit(limit + 1).offset(f.offset ?? 0);
    const [{ total }] = await tx.select({ total: count() }).from(cases).where(where);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit, total };
  });
}

async function loadCase(tx: Db, ctx: OfficeContext, caseId: string) {
  const [c] = await tx.select().from(cases).where(and(eq(cases.id, caseId), eq(cases.organizationId, ctx.orgId)));
  if (!c) throw notFound("Case not found.");
  if (c.isSensitive && !can(ctx, "cases.read_sensitive") && c.assignedTo !== ctx.userId) throw forbidden("This case is restricted to authorized caseworkers.");
  return c;
}

export async function getCaseDetail(ctx: OfficeContext, caseId: string) {
  requirePermission(ctx, "cases.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const c = await loadCase(tx, ctx, caseId);
    const [contact] = c.contactId ? await tx.select().from(contacts).where(eq(contacts.id, c.contactId)) : [];
    const [agency] = c.agencyId ? await tx.select().from(agencyDirectory).where(eq(agencyDirectory.id, c.agencyId)) : [];
    const events = await tx.select({
      id: caseEvents.id, type: caseEvents.type, body: caseEvents.body, data: caseEvents.data, visibility: caseEvents.visibility,
      createdAt: caseEvents.createdAt, actor: users.name,
    }).from(caseEvents).leftJoin(users, eq(users.id, caseEvents.actorId)).where(eq(caseEvents.caseId, caseId)).orderBy(desc(caseEvents.createdAt));
    const messages = await tx.select({
      id: emailMessages.id, subject: emailMessages.subject, sentAt: emailMessages.sentAt, direction: emailMessages.direction, fromName: emailMessages.fromName,
      fromAddress: emailMessages.fromAddress, summary: emailMessages.summary,
    }).from(caseMessages).innerJoin(emailMessages, eq(emailMessages.id, caseMessages.messageId)).where(eq(caseMessages.caseId, caseId))
      .orderBy(desc(emailMessages.sentAt));
    const caseTasks = await tx.select().from(tasks).where(eq(tasks.caseId, caseId)).orderBy(asc(tasks.dueAt));
    const assignee = c.assignedTo ? (await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, c.assignedTo)))[0] : null;
    return { case: c, contact: contact ?? null, agency: agency ?? null, events, messages, tasks: caseTasks, assignee };
  });
}

export async function updateCase(
  ctx: OfficeContext, caseId: string,
  patch: Partial<{
    status: CaseStatus; priority: CasePriority; assignedTo: string | null; followUpAt: string | null; agencyId: string | null; category: string; title: string;
    resolutionNotes: string;
  }>,
) {
  requirePermission(ctx, "cases.write");
  return withTenant(tenantScope(ctx), async (tx) => {
    const c = await loadCase(tx, ctx, caseId);
    const now = new Date();
    const set: Partial<typeof cases.$inferInsert> = { lastActivityAt: now };
    const events: (typeof caseEvents.$inferInsert)[] = [];
    const ev = (type: (typeof caseEvents.$inferInsert)["type"], data: Record<string, unknown>) => events.push({
      organizationId: ctx.orgId, caseId, actorId: ctx.userId, type, data,
    });
    if (patch.status && patch.status !== c.status) {
      if ((patch.status === "resolved" || patch.status === "closed") && !(patch.resolutionNotes ?? c.resolutionNotes)?.trim()) {
        throw new AppError("validation", "Add resolution notes before resolving or closing a case.");
      }
      set.status = patch.status;
      if (patch.status === "resolved") set.resolvedAt = now;
      if (patch.status === "closed") set.closedAt = now;
      if (patch.status === "awaiting_agency" && !c.referredAt) set.referredAt = now;
      ev("status_changed", { from: c.status, to: patch.status });
    }
    if (patch.priority && patch.priority !== c.priority) {
      set.priority = patch.priority;
      ev("priority_changed", { from: c.priority, to: patch.priority });
    }
    if (patch.assignedTo !== undefined && patch.assignedTo !== c.assignedTo) {
      await assertStaff(tx, ctx.orgId, patch.assignedTo);
      set.assignedTo = patch.assignedTo;
      if (c.assignedTo) {
        await tx.update(caseAssignments).set({ unassignedAt: now })
          .where(and(eq(caseAssignments.caseId, caseId), sql`${caseAssignments.unassignedAt} is null`));
      }
      if (patch.assignedTo) await tx.insert(caseAssignments).values({ organizationId: ctx.orgId, caseId, userId: patch.assignedTo, assignedBy: ctx.userId });
      ev("assigned", { userId: patch.assignedTo });
    }
    if (patch.followUpAt !== undefined) {
      set.followUpAt = patch.followUpAt ? new Date(patch.followUpAt) : null;
      ev("follow_up_set", { at: patch.followUpAt });
    }
    if (patch.agencyId !== undefined) {
      await assertOwn(tx, ctx.orgId, { agencyId: patch.agencyId });
      set.agencyId = patch.agencyId;
    }
    if (patch.category) set.category = patch.category;
    if (patch.title) set.title = patch.title.slice(0, 200);
    if (patch.resolutionNotes !== undefined) set.resolutionNotes = patch.resolutionNotes;
    await tx.update(cases).set(set).where(eq(cases.id, caseId));
    if (events.length) await tx.insert(caseEvents).values(events);
    await audit(tx, ctx, "case.updated", "case", caseId, { fields: Object.keys(patch) });
  });
}

export async function addCaseNote(ctx: OfficeContext, caseId: string, body: string, visibility: "office" | "private" = "office") {
  requirePermission(ctx, "cases.write");
  if (!body.trim()) throw new AppError("validation", "Note is empty.");
  return withTenant(tenantScope(ctx), async (tx) => {
    await loadCase(tx, ctx, caseId);
    await tx.insert(caseEvents)
      .values({ organizationId: ctx.orgId, caseId, actorId: ctx.userId, type: "note", visibility, body: body.trim().slice(0, 10_000) });
    await tx.update(cases).set({ lastActivityAt: new Date() }).where(eq(cases.id, caseId));
  });
}

export async function listAgencies(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select().from(agencyDirectory).where(and(eq(agencyDirectory.organizationId, ctx.orgId), eq(agencyDirectory.isActive, true)))
      .orderBy(agencyDirectory.name));
}
