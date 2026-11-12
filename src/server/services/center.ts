import { and, asc, count, desc, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant, type Db } from "../db/client";
import {
  agencyDirectory, bills, cases, classificationRuns, contactAddresses, contactEmails, contacts, emailConnections, emailDrafts, emailMessages, emailSyncState,
  integrationErrors, issueTaxonomy, mailLedger, mailReconciliations, messageAsks, officeSettings, organizations, reviewQueue, senderRules, templateClusters,
  users, type LedgerDisposition, type SenderRuleKind,
} from "../db/schema";
import { can, requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { getEnv, integrationsConfigured } from "../env";
import { AppError, notFound } from "../errors";
import { enqueue } from "../jobs/queue";
import type { BillRequestKey } from "../classification/categories";
import { flattenTaxonomy } from "../classification/default-taxonomy";
import { FREEMAIL } from "../classification/rules";
import { PIPELINE_VERSION } from "../classification/schema";
import { mayManageMailbox } from "../email/connections";
import { mailboxCanSend } from "../email/send";
import { audit } from "./audit";
import { createCase, type CreateCaseInput } from "./cases";

export const DISPOSITION_LABEL: Record<LedgerDisposition, string> = {
  filed: "In the office's mail", held: "Waiting for a person", hidden: "Set aside by a sender rule", screened: "Newsletter or spam",
  duplicate: "Already stored", failed: "Could not be read", pending: "Being processed",
};

const RESTRICTED = "Sensitive. Your role cannot open this message.";

export const mayRead = (ctx: OfficeContext, m: { isSensitive: boolean; assignedTo: string | null }) =>
  !m.isSensitive || can(ctx, "cases.read_sensitive") || m.assignedTo === ctx.userId;

const DEFAULT_RELAY_DOMAINS = ["votervoice.net", "p2a.co", "actionnetwork.org", "quorum.us"];

const STARTER_AGENCIES: Record<string, { name: string; abbreviation: string }[]> = {
  GA: [
    { name: "Georgia Department of Labor", abbreviation: "GDOL" }, { name: "Department of Driver Services", abbreviation: "DDS" },
    { name: "Division of Family and Children Services", abbreviation: "DFCS" }, { name: "Department of Community Health", abbreviation: "DCH" },
    { name: "Department of Revenue", abbreviation: "DOR" }, { name: "Department of Transportation", abbreviation: "GDOT" },
    { name: "Department of Human Services", abbreviation: "DHS" },
    { name: "Department of Behavioral Health and Developmental Disabilities", abbreviation: "DBHDD" },
    { name: "Department of Veterans Service", abbreviation: "GDVS" }, { name: "Department of Corrections", abbreviation: "GDC" },
    { name: "Secretary of State", abbreviation: "SOS" }, { name: "Department of Public Health", abbreviation: "DPH" },
  ],
  ZZ: [
    { name: "Demo State Department of Labor", abbreviation: "DSDOL" }, { name: "Demo State Division of Motor Vehicles", abbreviation: "DMV" },
    { name: "Demo State Department of Health Services", abbreviation: "DHS" }, { name: "Demo State Department of Revenue", abbreviation: "DOR" },
  ],
};

export async function hasMailbox(orgId: string) {
  const rows = await withTenant({ orgId }, (tx) =>
    tx.select({ id: emailConnections.id }).from(emailConnections).where(eq(emailConnections.organizationId, orgId)).limit(1));
  return rows.length > 0;
}

export async function centerEnabled(orgId: string) {
  const [s] = await withTenant({ orgId }, (tx) =>
    tx.select({ enabled: officeSettings.centerEnabled }).from(officeSettings).where(eq(officeSettings.organizationId, orgId)));
  return Boolean(s?.enabled);
}

// Platform operation (CLI or demo seed), never reachable from the web app.
export async function enableConstituentCenter(orgId: string) {
  const db = await systemDb();
  const [org] = await db.select({ isDemo: organizations.isDemo, jurisdictionCode: organizations.jurisdictionCode }).from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new AppError("not_found", "Office not found.");
  if (org.isDemo && getEnv().APP_ENV !== "demo" && getEnv().APP_ENV !== "test") {
    throw new AppError("validation", "A demo office can only be enabled in the demo environment.");
  }
  await withTenant({ orgId }, async (tx) => {
    await tx.update(officeSettings).set({ centerEnabled: true, centerEnabledAt: new Date(), updatedAt: new Date() })
      .where(eq(officeSettings.organizationId, orgId));
    await tx.insert(senderRules)
      .values(DEFAULT_RELAY_DOMAINS.map((value) => ({
        organizationId: orgId, kind: "relay" as const, matchType: "domain" as const, value, status: "active" as const, proposedBy: "system" as const,
        reason: "Common advocacy platform",
      })))
      .onConflictDoNothing();
    await tx.insert(issueTaxonomy).values(flattenTaxonomy().map((n) => ({ organizationId: orgId, ...n }))).onConflictDoNothing();
    const agencies = STARTER_AGENCIES[org.jurisdictionCode] ?? [];
    if (agencies.length) await tx.insert(agencyDirectory).values(agencies.map((a) => ({ organizationId: orgId, ...a }))).onConflictDoNothing();
  });
}

const askRow = {
  id: messageAsks.id, kind: messageAsks.kind, summary: messageAsks.summary, quote: messageAsks.quote, urgency: messageAsks.urgency, dueAt: messageAsks.dueAt,
  messageId: messageAsks.messageId, subject: emailMessages.subject, fromName: emailMessages.fromName, fromAddress: emailMessages.fromAddress,
  receivedAt: emailMessages.receivedAt, senderTrust: emailMessages.senderTrust, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
  assignee: users.name, districtStatus: contacts.districtStatus,
};

type AskRow = { id: string; quote: string; summary: string; subject: string; isSensitive: boolean; assignedTo: string | null };
const redactAsk = <T extends AskRow>(ctx: OfficeContext, a: T): T =>
  (mayRead(ctx, a) ? a : { ...a, quote: RESTRICTED, summary: "Sensitive request", subject: "Sensitive message" });

async function openAsks(tx: Db, ctx: OfficeContext, where: SQL | undefined, limit: number) {
  const rows = await tx.select(askRow).from(messageAsks).innerJoin(emailMessages, eq(emailMessages.id, messageAsks.messageId))
    .leftJoin(users, eq(users.id, emailMessages.assignedTo)).leftJoin(contacts, eq(contacts.id, emailMessages.contactId))
    .where(and(
      eq(messageAsks.organizationId, ctx.orgId), eq(messageAsks.status, "open"), sql`${emailMessages.triageStatus} not in ('done', 'archived')`, where,
    ))
    .orderBy(
      sql`case when ${messageAsks.kind} = 'safety' then 0 when ${messageAsks.urgency} = 'urgent' then 1 else 2 end`, sql`${messageAsks.dueAt} asc nulls last`,
      desc(emailMessages.receivedAt),
    )
    .limit(limit);
  return rows.map((a) => redactAsk(ctx, a));
}

export type DistrictView = "in" | "outside" | "unknown";

export function districtIs(view: DistrictView): SQL {
  if (view === "unknown") return sql`not exists (select 1 from contacts c where c.id = ${emailMessages.contactId} and c.district_status is not null)`;
  return sql`exists (select 1 from contacts c where c.id = ${emailMessages.contactId} and c.district_status ${view === "in" ? sql`= 'in_district'` : sql`in ('outside', 'out_of_state')`})`;
}

export async function needsAPerson(ctx: OfficeContext, f: { district?: DistrictView } = {}) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const where = f.district ? districtIs(f.district) : undefined;
    const [placed] = await tx.select({ n: count() }).from(contacts).where(and(eq(contacts.organizationId, ctx.orgId), isNotNull(contacts.districtStatus)));
    const urgent = await openAsks(tx, ctx, and(sql`${messageAsks.urgency} in ('urgent', 'soon')`, where), 40);
    const casework = await openAsks(tx, ctx, and(eq(messageAsks.kind, "casework"), eq(messageAsks.urgency, "routine"), where), 40);
    const others = await openAsks(
      tx, ctx, and(inArray(messageAsks.kind, ["meeting", "information", "follow_up", "other"]), eq(messageAsks.urgency, "routine"), where), 40,
    );
    const senders = await tx.select({
      id: reviewQueue.id, reason: reviewQueue.reason, messageId: reviewQueue.messageId, subject: emailMessages.subject, fromName: emailMessages.fromName,
      fromAddress: emailMessages.fromAddress, receivedAt: emailMessages.receivedAt, trust: emailMessages.senderTrust,
      claimedAddress: emailMessages.claimedAddress, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
    }).from(reviewQueue).innerJoin(emailMessages, eq(emailMessages.id, reviewQueue.messageId))
      .where(and(eq(reviewQueue.organizationId, ctx.orgId), eq(reviewQueue.kind, "sender_check"), eq(reviewQueue.status, "open"), where))
      .orderBy(desc(reviewQueue.priority), desc(emailMessages.receivedAt)).limit(40);
    const personal = await tx.select({
      id: emailMessages.id, note: emailMessages.personalNote, fromName: emailMessages.fromName, fromAddress: emailMessages.fromAddress,
      receivedAt: emailMessages.receivedAt, subject: emailMessages.subject, clusterId: emailMessages.templateClusterId, isSensitive: emailMessages.isSensitive,
      assignedTo: emailMessages.assignedTo,
    }).from(emailMessages)
      .where(and(
        eq(emailMessages.organizationId, ctx.orgId), isNotNull(emailMessages.personalNote), sql`${emailMessages.triageStatus} not in ('done', 'archived')`,
        where,
      ))
      .orderBy(desc(emailMessages.receivedAt)).limit(20);
    return {
      anyonePlaced: placed.n > 0, urgent, senders: senders.map((x) => (mayRead(ctx, x) ? x : { ...x, subject: "Sensitive message" })), casework, others,
      personal: personal.map((p) => (mayRead(ctx, p) ? p : { ...p, note: RESTRICTED, subject: "Sensitive message" })),
    };
  });
}

export async function centerCounts(ctx: OfficeContext) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const [asks] = await tx.select({
      n: sql<number>`count(distinct ${messageAsks.messageId})::int`,
      urgent: sql<number>`count(distinct ${messageAsks.messageId}) filter (where ${messageAsks.urgency} = 'urgent')::int`,
    }).from(messageAsks).innerJoin(emailMessages, eq(emailMessages.id, messageAsks.messageId))
      .where(and(
        eq(messageAsks.organizationId, ctx.orgId), eq(messageAsks.status, "open"), sql`${messageAsks.kind} <> 'position'`,
        sql`${emailMessages.triageStatus} not in ('done', 'archived')`,
      ));
    const [senders] = await tx.select({ n: count() }).from(reviewQueue)
      .where(and(eq(reviewQueue.organizationId, ctx.orgId), eq(reviewQueue.kind, "sender_check"), eq(reviewQueue.status, "open")));
    const [newMail] = await tx.select({ n: count() }).from(emailMessages)
      .where(and(
        eq(emailMessages.organizationId, ctx.orgId), eq(emailMessages.direction, "inbound"), eq(emailMessages.triageStatus, "new"),
        eq(emailMessages.isSpam, false), eq(emailMessages.isAutomated, false),
      ));
    const [openCases] = can(ctx, "cases.read")
      ? await tx.select({ n: count() }).from(cases).where(and(eq(cases.organizationId, ctx.orgId), sql`${cases.status} not in ('resolved', 'closed')`))
      : [{ n: 0 }];
    const [drafts] = await tx.select({ n: count() }).from(emailDrafts)
      .where(and(eq(emailDrafts.organizationId, ctx.orgId), inArray(emailDrafts.status, ["draft", "approved"])));
    const [gaps] = await tx.select({ n: count() }).from(mailLedger)
      .where(and(eq(mailLedger.organizationId, ctx.orgId), inArray(mailLedger.disposition, ["failed", "pending"])));
    return { needsPerson: asks.n + senders.n, urgent: asks.urgent, newMail: newMail.n, openCases: openCases.n, drafts: drafts.n, ledgerProblems: gaps.n };
  });
}

export async function ledgerOverview(ctx: OfficeContext) {
  requirePermission(ctx, "ledger.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const groups = await tx.select({ disposition: mailLedger.disposition, n: count() }).from(mailLedger).where(eq(mailLedger.organizationId, ctx.orgId))
      .groupBy(mailLedger.disposition);
    const byDisposition = Object.fromEntries(groups.map((g) => [g.disposition, g.n])) as Partial<Record<LedgerDisposition, number>>;
    const [last] = await tx.select().from(mailReconciliations).where(eq(mailReconciliations.organizationId, ctx.orgId))
      .orderBy(desc(mailReconciliations.createdAt)).limit(1);
    return { byDisposition, total: groups.reduce((a, g) => a + g.n, 0), lastCheck: last ?? null };
  });
}

export async function listLedger(ctx: OfficeContext, f: { disposition?: LedgerDisposition; limit?: number; offset?: number }) {
  requirePermission(ctx, "ledger.read");
  const limit = Math.min(f.limit ?? 100, 200);
  return withTenant(tenantScope(ctx), async (tx) => {
    const where = and(eq(mailLedger.organizationId, ctx.orgId), f.disposition ? eq(mailLedger.disposition, f.disposition) : undefined);
    const rows = await tx.select({
      id: mailLedger.id, disposition: mailLedger.disposition, reason: mailLedger.reason, fromAddress: mailLedger.fromAddress, subject: mailLedger.subject,
      receivedAt: mailLedger.receivedAt, createdAt: mailLedger.createdAt, messageId: mailLedger.messageId, direction: emailMessages.direction,
      attempts: mailLedger.attempts, restoredAt: mailLedger.restoredAt, isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo,
    }).from(mailLedger).leftJoin(emailMessages, eq(emailMessages.id, mailLedger.messageId)).where(where)
      .orderBy(desc(sql`coalesce(${mailLedger.receivedAt}, ${mailLedger.createdAt})`)).limit(limit + 1).offset(f.offset ?? 0);
    return {
      items: rows.slice(0, limit)
        .map((r) => (r.isSensitive && !mayRead(ctx, { isSensitive: true, assignedTo: r.assignedTo })) ? { ...r, subject: "Sensitive message" } : r),
      hasMore: rows.length > limit,
    };
  });
}

export async function restoreFromLedger(ctx: OfficeContext, ledgerId: string) {
  requirePermission(ctx, "senders.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [row] = await tx.select().from(mailLedger).where(and(eq(mailLedger.id, ledgerId), eq(mailLedger.organizationId, ctx.orgId)));
    if (!row?.messageId) throw notFound("That message is not stored here.");
    if (row.disposition !== "hidden" && row.disposition !== "screened") throw new AppError("validation", "Only mail that was set aside can be restored.");
    await tx.update(mailLedger).set({ disposition: "filed", reason: "Restored by staff.", restoredBy: ctx.userId, restoredAt: new Date() })
      .where(eq(mailLedger.id, ledgerId));
    await tx.update(emailMessages).set({ triageStatus: "new", isSpam: false, isAutomated: false }).where(eq(emailMessages.id, row.messageId));
    await audit(tx, ctx, "ledger.restored", "mail_ledger", ledgerId);
    await enqueue(
      "message.classify", { messageId: row.messageId }, { orgId: ctx.orgId, idempotencyKey: `classify:${row.messageId}:${PIPELINE_VERSION}:restored` }, tx,
    );
  });
}

async function loadHeld(tx: Db, ctx: OfficeContext, messageId: string) {
  const [m] = await tx.select().from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, ctx.orgId)));
  if (!m) throw notFound("Message not found.");
  if (m.senderTrust !== "failed" && m.senderTrust !== "unverified") throw new AppError("validation", "This sender does not need confirming.");
  return m;
}

async function closeSenderCheck(tx: Db, ctx: OfficeContext, messageId: string, resolution: string) {
  await tx.update(reviewQueue).set({ status: "resolved", resolvedBy: ctx.userId, resolvedAt: new Date(), resolution })
    .where(and(
      eq(reviewQueue.organizationId, ctx.orgId), eq(reviewQueue.messageId, messageId), eq(reviewQueue.kind, "sender_check"), eq(reviewQueue.status, "open"),
    ));
}

// Only once a person vouches can the message join a record or reach AI.
export async function confirmSender(ctx: OfficeContext, messageId: string) {
  requirePermission(ctx, "senders.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    const m = await loadHeld(tx, ctx, messageId);
    const [link] = await tx.select({ contactId: contactEmails.contactId }).from(contactEmails)
      .where(and(eq(contactEmails.organizationId, ctx.orgId), eq(contactEmails.email, m.fromAddress)));
    let contactId = link?.contactId ?? null;
    if (!contactId) {
      const parts = (m.fromName ?? "").split(/\s+/).filter(Boolean);
      const [c] = await tx.insert(contacts)
        .values({
          organizationId: ctx.orgId, kind: m.fromName ? "person" : "unknown", fullName: m.fromName, firstName: parts.length > 1 ? parts[0] : null,
          lastName: parts.length > 1 ? parts[parts.length - 1] : null, firstSeenAt: new Date(), lastContactAt: m.sentAt,
        })
        .returning({ id: contacts.id });
      contactId = c.id;
      await tx.insert(contactEmails)
        .values({ organizationId: ctx.orgId, contactId, email: m.fromAddress, isPrimary: true, verified: true, verifiedSource: "staff" });
    }
    await tx.update(emailMessages)
      .set({
        senderTrust: "verified", senderTrustDetail: { ...m.senderTrustDetail, reasons: [...m.senderTrustDetail.reasons, "Confirmed by staff."] }, contactId,
      })
      .where(eq(emailMessages.id, messageId));
    await tx.update(mailLedger).set({ disposition: "filed", reason: "Sender confirmed by staff." })
      .where(and(eq(mailLedger.organizationId, ctx.orgId), eq(mailLedger.messageId, messageId)));
    await closeSenderCheck(tx, ctx, messageId, "confirmed");
    await audit(tx, ctx, "sender.confirmed", "email_message", messageId);
    await enqueue("message.classify", { messageId }, { orgId: ctx.orgId, idempotencyKey: `classify:${messageId}:${PIPELINE_VERSION}:confirmed` }, tx);
  });
}

export async function rejectSender(ctx: OfficeContext, messageId: string) {
  requirePermission(ctx, "senders.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await loadHeld(tx, ctx, messageId);
    await tx.update(emailMessages).set({ triageStatus: "archived", requiresReview: false }).where(eq(emailMessages.id, messageId));
    await tx.update(mailLedger).set({ disposition: "hidden", reason: "Staff marked this as not genuine." })
      .where(and(eq(mailLedger.organizationId, ctx.orgId), eq(mailLedger.messageId, messageId)));
    await closeSenderCheck(tx, ctx, messageId, "not_genuine");
    await audit(tx, ctx, "sender.rejected", "email_message", messageId);
  });
}

export async function setAskStatus(ctx: OfficeContext, askId: string, status: "handled" | "dismissed" | "open") {
  requirePermission(ctx, "inbox.triage");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [a] = await tx.update(messageAsks).set({ status, handledBy: status === "open" ? null : ctx.userId, handledAt: status === "open" ? null : new Date() })
      .where(and(eq(messageAsks.id, askId), eq(messageAsks.organizationId, ctx.orgId))).returning({ id: messageAsks.id });
    if (!a) throw notFound("That request was not found.");
    await audit(tx, ctx, `ask.${status}`, "message_ask", askId);
  });
}

export async function openCaseFromAsk(ctx: OfficeContext, askId: string, input: Pick<CreateCaseInput, "assignedTo" | "agencyId" | "category" | "title">) {
  requirePermission(ctx, "cases.write");
  const ask = await withTenant(tenantScope(ctx), async (tx) => {
    const [a] = await tx.select().from(messageAsks).where(and(eq(messageAsks.id, askId), eq(messageAsks.organizationId, ctx.orgId)));
    if (!a) throw notFound("That request was not found.");
    return a;
  });
  // Only what the form asks for; the person on the case is the one who wrote.
  const c = await createCase(ctx, {
    title: input.title, category: input.category, assignedTo: input.assignedTo, agencyId: input.agencyId, description: ask.quote,
    sourceMessageId: ask.messageId, priority: ask.urgency === "urgent" ? "urgent" : ask.urgency === "soon" ? "high" : "normal",
    followUpAt: ask.dueAt?.toISOString() ?? null,
  });
  await withTenant(tenantScope(ctx), (tx) =>
    tx.update(messageAsks).set({ status: "handled", caseId: c.id, handledBy: ctx.userId, handledAt: new Date() }).where(eq(messageAsks.id, askId)));
  return c;
}

export async function listSenderRules(ctx: OfficeContext) {
  requirePermission(ctx, "senders.manage");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select().from(senderRules).where(eq(senderRules.organizationId, ctx.orgId))
      .orderBy(asc(senderRules.kind), asc(senderRules.status), asc(senderRules.value)));
}

function senderValue(raw: string) {
  const value = raw.trim().toLowerCase().replace(/^\*?@/, "");
  const matchType = value.includes("@") ? ("address" as const) : ("domain" as const);
  const valid = matchType === "address" ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) : /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value);
  return { value, matchType, valid };
}

export async function addSenderRule(ctx: OfficeContext, input: { kind: SenderRuleKind; value: string; reason?: string }) {
  requirePermission(ctx, "senders.manage");
  const { value, matchType, valid } = senderValue(input.value);
  if (!valid) throw new AppError("validation", "Enter an email address or a domain such as example.org.");
  if (matchType === "domain" && FREEMAIL.has(value)) {
    throw new AppError("validation", `${value} is a public mail service. A rule for it would catch constituents. Add the single address instead.`);
  }
  await withTenant(tenantScope(ctx), async (tx) => {
    const [org] = await tx.select({ d: organizations.internalDomains }).from(organizations).where(eq(organizations.id, ctx.orgId));
    if (matchType === "domain" && org.d.some((d) => d === value || d.endsWith(`.${value}`))) {
      throw new AppError("validation", "That is this office's own domain.");
    }
    const [r] = await tx.insert(senderRules)
      .values({
        organizationId: ctx.orgId, kind: input.kind, matchType, value, status: "active", proposedBy: "staff", reason: input.reason?.trim() || null,
        createdBy: ctx.userId, confirmedBy: ctx.userId, confirmedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [senderRules.organizationId, senderRules.kind, senderRules.matchType, senderRules.value],
        set: { status: "active", confirmedBy: ctx.userId, confirmedAt: new Date() },
      })
      .returning({ id: senderRules.id });
    await audit(tx, ctx, "sender_rule.added", "sender_rule", r.id, { kind: input.kind, matchType });
    if (input.kind === "relay") await enqueue("mail.reattribute", { ruleId: r.id }, { orgId: ctx.orgId }, tx);
  });
}

export async function setSenderRuleStatus(ctx: OfficeContext, ruleId: string, status: "active" | "retired") {
  requirePermission(ctx, "senders.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [r] = await tx.update(senderRules).set({ status, ...(status === "active" ? { confirmedBy: ctx.userId, confirmedAt: new Date() } : {}) })
      .where(and(eq(senderRules.id, ruleId), eq(senderRules.organizationId, ctx.orgId))).returning({ id: senderRules.id, kind: senderRules.kind });
    if (!r) throw notFound("Rule not found.");
    await audit(tx, ctx, `sender_rule.${status}`, "sender_rule", ruleId);
    if (r.kind === "relay") await enqueue("mail.reattribute", { ruleId }, { orgId: ctx.orgId }, tx);
  });
}

export const PERSON = sql.raw("coalesce(m.contact_id::text, m.claimed_address, case when m.sender_trust = 'relay' then m.id::text else m.from_address end)");
export const CONFIRMED = sql.raw("m.sender_trust in ('verified', 'relay')");

// One letter stands for a person on a bill: the one that takes a side, else the newest.
export const THEIR_WORD = sql.raw("(p.position in ('support', 'oppose', 'mixed')) desc nulls last, m.received_at desc");

export const CAMPAIGNS = sql`(select m.template_cluster_id from email_messages m where m.template_cluster_id is not null and ${CONFIRMED} group by 1 having count(distinct ${PERSON}) >= 2)`;

export async function campaignPeople(tx: Db, clusterId: string) {
  const rows = await tx.execute<{ n: number }>(
    sql`select count(distinct ${PERSON})::int as n from email_messages m where m.template_cluster_id = ${clusterId} and ${CONFIRMED}`,
  );
  return rows.rows[0]?.n ?? 0;
}

export async function listFormLetters(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const rows = await tx.execute<{
      id: string; people: number; with_notes: number; first_seen_at: Date | string; last_seen_at: Date | string; subject: string | null; bill: string | null;
      stance: string | null;
    }>(sql`
      select t.id, t.first_seen_at, t.last_seen_at, p.people, p.with_notes,
        (select m.subject from email_messages m where m.id = t.sample_message_id) as subject,
        (select i.bill_reference from issue_positions i join email_messages m on m.id = i.message_id where m.template_cluster_id = t.id and i.bill_reference is not null group by 1 order by count(*) desc limit 1) as bill,
        (select i.position from issue_positions i join email_messages m on m.id = i.message_id where m.template_cluster_id = t.id and i.bill_reference is not null and i.position not in ('unclear', 'neutral') group by 1 order by count(*) desc limit 1) as stance
      from template_clusters t
      cross join lateral (
        select count(distinct ${PERSON})::int as people, count(distinct ${PERSON}) filter (where m.personal_note is not null)::int as with_notes
        from email_messages m where m.template_cluster_id = t.id and ${CONFIRMED}
      ) p
      where t.organization_id = ${ctx.orgId} and p.people >= 2
      order by t.last_seen_at desc
      limit 100`);
    return rows.rows.map((r) => ({
      id: r.id, people: r.people, withNotes: r.with_notes, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, subject: r.subject, bill: r.bill,
      stance: r.stance,
    }));
  });
}

export async function getFormLetter(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [c] = await tx.select().from(templateClusters).where(and(eq(templateClusters.id, id), eq(templateClusters.organizationId, ctx.orgId)));
    if (!c) throw notFound("Form letter not found.");
    const members = await tx.select({
      id: emailMessages.id, fromName: emailMessages.fromName, fromAddress: emailMessages.fromAddress, contactId: emailMessages.contactId,
      claimedAddress: emailMessages.claimedAddress, claimedName: emailMessages.claimedName, receivedAt: emailMessages.receivedAt,
      note: emailMessages.personalNote, senderTrust: emailMessages.senderTrust, triageStatus: emailMessages.triageStatus,
      isSensitive: emailMessages.isSensitive, assignedTo: emailMessages.assignedTo, substantiveText: emailMessages.substantiveText,
      subject: emailMessages.subject,
    }).from(emailMessages).where(and(eq(emailMessages.organizationId, ctx.orgId), eq(emailMessages.templateClusterId, id)))
      .orderBy(sql`${emailMessages.personalNote} is null`, desc(emailMessages.receivedAt)).limit(500);
    const sample = members.find((m) => m.id === c.sampleMessageId) ?? members[members.length - 1] ?? null;
    const isConfirmed = (m: (typeof members)[number]) => m.senderTrust === "verified" || m.senderTrust === "relay";
    const seen = new Set<string>();
    const people = members.filter((m) => {
      const key = m.contactId ?? m.claimedAddress ?? (m.senderTrust === "relay" ? m.id : m.fromAddress);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const confirmed = people.filter(isConfirmed);
    return {
      cluster: c, people: confirmed.length, unconfirmed: people.length - confirmed.length, subject: sample?.subject ?? "Form letter",
      letter: sample?.substantiveText ?? "", members: people.map((m) => (mayRead(ctx, m) ? m : { ...m, note: m.note ? RESTRICTED : null })),
    };
  });
}

export async function topics(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const billRows = await tx.execute<{
      bill_id: string | null; reference: string; title: string | null; people: number; in_district: number; support: number; oppose: number; other: number;
      form_letters: number;
    }>(sql`
      select (array_agg(s.bill_id) filter (where s.bill_id is not null))[1] as bill_id, s.reference, min(b.title) as title,
        count(*)::int as people,
        count(*) filter (where c.district_status = 'in_district')::int as in_district,
        count(*) filter (where s.position = 'support')::int as support,
        count(*) filter (where s.position = 'oppose')::int as oppose,
        count(*) filter (where s.position not in ('support', 'oppose'))::int as other,
        count(*) filter (where s.template_cluster_id in ${CAMPAIGNS})::int as form_letters
      from (
        select distinct on (p.bill_reference, ${PERSON}) p.bill_reference as reference, p.bill_id, p.position, m.template_cluster_id, m.contact_id
        from issue_positions p
        join email_messages m on m.id = p.message_id
        where p.organization_id = ${ctx.orgId} and p.target_type = 'bill' and p.status <> 'rejected'
          and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null
        order by p.bill_reference, ${PERSON}, ${THEIR_WORD}
      ) s
      left join contacts c on c.id = s.contact_id
      left join bills b on b.id = s.bill_id
      group by s.reference
      order by people desc, s.reference
      limit 60`);
    const issueRows = await tx.execute<{ key: string; label: string | null; people: number; in_district: number; support: number; oppose: number }>(sql`
      select s.key, min(t.label) as label,
        count(*)::int as people,
        count(*) filter (where c.district_status = 'in_district')::int as in_district,
        count(*) filter (where s.position = 'support')::int as support,
        count(*) filter (where s.position = 'oppose')::int as oppose
      from (
        select distinct on (l.issue_key, ${PERSON}) l.issue_key as key, p.position, m.contact_id
        from message_issue_links l
        join email_messages m on m.id = l.message_id
        left join issue_positions p on p.message_id = l.message_id and p.issue_key = l.issue_key and p.status <> 'rejected'
        where l.organization_id = ${ctx.orgId} and l.status <> 'rejected' and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null and l.issue_key like '%.%'
        order by l.issue_key, ${PERSON}, ${THEIR_WORD}
      ) s
      left join contacts c on c.id = s.contact_id
      left join issue_taxonomy t on t.organization_id = ${ctx.orgId} and t.key = s.key
      group by s.key
      order by people desc, s.key
      limit 30`);
    return { bills: billRows.rows, issues: issueRows.rows };
  });
}

export type BillSide = "support" | "oppose" | "other";
const WEEKS_SHOWN = 12;

// Up to twelve weeks; empty weeks are kept so the columns follow the calendar.
function fillWeeks(rows: { week: string; support: number; oppose: number; other: number }[]) {
  if (!rows.length) return [];
  const out = [];
  const last = new Date(`${rows[rows.length - 1].week}T12:00:00Z`).getTime();
  const first = Math.max(new Date(`${rows[0].week}T12:00:00Z`).getTime(), last - (WEEKS_SHOWN - 1) * 7 * 86400_000);
  for (let t = first; t <= last; t += 7 * 86400_000) {
    const week = new Date(t).toISOString().slice(0, 10);
    out.push(rows.find((r) => r.week === week) ?? { week, support: 0, oppose: 0, other: 0 });
  }
  return out;
}

export async function billCorrespondence(ctx: OfficeContext, reference: string, page: { limit?: number; offset?: number; side?: BillSide } = {}) {
  requirePermission(ctx, "inbox.read");
  const limit = Math.min(page.limit ?? 100, 500);
  const onSide = page.side === "other" ? sql`where s.position not in ('support', 'oppose')` : page.side ? sql`where s.position = ${page.side}` : sql``;
  return withTenant(tenantScope(ctx), async (tx) => {
    const perPerson = sql`(
      select distinct on (${PERSON}) m.id as message_id, coalesce(c.full_name, m.claimed_name, m.from_name) as name, coalesce(m.claimed_address, m.from_address) as address,
        p.position, p.requested_action, p.evidence, p.bill_id, b.title, c.district_status, m.received_at, m.is_sensitive, m.assigned_to,
        coalesce(m.template_cluster_id in ${CAMPAIGNS}, false) as form_letter
      from issue_positions p
      join email_messages m on m.id = p.message_id
      left join contacts c on c.id = m.contact_id
      left join bills b on b.id = p.bill_id
      where p.organization_id = ${ctx.orgId} and p.bill_reference = ${reference} and p.target_type = 'bill' and p.status <> 'rejected'
        and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null
      order by ${PERSON}, ${THEIR_WORD}
    ) s`;
    const groups = await tx.execute<{
      position: string; requested_action: BillRequestKey | null; in_district: boolean | null; n: number; bill_id: string | null; title: string | null;
    }>(sql`
      select s.position, s.requested_action, (s.district_status = 'in_district') as in_district, count(*)::int as n, min(s.bill_id::text) as bill_id, min(s.title) as title
      from ${perPerson} group by 1, 2, 3`);
    const rows = await tx.execute<{
      message_id: string; name: string | null; address: string; position: string; requested_action: BillRequestKey | null; evidence: { text: string }[];
      district_status: string | null; form_letter: boolean; received_at: Date | string; is_sensitive: boolean; assigned_to: string | null;
    }>(sql`
      select s.message_id, s.name, s.address, s.position, s.requested_action, s.evidence, s.district_status, s.form_letter, s.received_at, s.is_sensitive, s.assigned_to
      from ${perPerson} ${onSide}
      -- A person's own letter before a form letter, and the newest first.
      order by s.form_letter, s.received_at desc, s.message_id
      limit ${limit + 1} offset ${page.offset ?? 0}`);
    const weeks = await tx.execute<{ week: string; support: number; oppose: number; other: number }>(sql`
      select date_trunc('week', s.received_at)::date::text as week,
        count(*) filter (where s.position = 'support')::int as support,
        count(*) filter (where s.position = 'oppose')::int as oppose,
        count(*) filter (where s.position not in ('support', 'oppose'))::int as other
      from ${perPerson} group by 1 order by 1`);
    const tally = (pick: (g: (typeof groups.rows)[number]) => string | null) => {
      const out: Record<string, number> = {};
      for (const g of groups.rows) {
        const k = pick(g);
        if (k) out[k] = (out[k] ?? 0) + g.n;
      }
      return out;
    };
    return {
      reference, billId: groups.rows.find((g) => g.bill_id)?.bill_id ?? null, title: groups.rows.find((g) => g.title)?.title ?? null,
      people: groups.rows.reduce((t, g) => t + g.n, 0), inDistrict: groups.rows.filter((g) => g.in_district).reduce((t, g) => t + g.n, 0),
      positions: tally((g) => g.position), requests: tally((g) => g.requested_action), hasMore: rows.rows.length > limit, weeks: fillWeeks(weeks.rows),
      inDistrictSides: tally((g) => (g.in_district ? (g.position === "support" || g.position === "oppose" ? g.position : "other") : null)),
      letters: rows.rows.slice(0, limit).map((r) => ({
        messageId: r.message_id, name: r.name ?? r.address, position: r.position, request: r.requested_action, districtStatus: r.district_status,
        formLetter: r.form_letter, receivedAt: r.received_at,
        quote: mayRead(ctx, { isSensitive: r.is_sensitive, assignedTo: r.assigned_to }) ? (r.evidence[0]?.text ?? null) : RESTRICTED,
      })),
    };
  });
}

// People who wrote each week, by the side they took on a bill.
export async function mailByWeek(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const rows = await tx.execute<{ week: string; support: number; oppose: number; other: number }>(sql`
      select s.week, count(*) filter (where s.side = 'support')::int as support, count(*) filter (where s.side = 'oppose')::int as oppose,
        count(*) filter (where s.side = 'other')::int as other
      from (
        select date_trunc('week', m.received_at)::date::text as week, ${PERSON} as person,
          case when bool_or(p.position = 'support') and not bool_or(p.position = 'oppose') then 'support'
               when bool_or(p.position = 'oppose') and not bool_or(p.position = 'support') then 'oppose' else 'other' end as side
        from email_messages m
        left join issue_positions p on p.message_id = m.id and p.target_type = 'bill' and p.status <> 'rejected'
        where m.organization_id = ${ctx.orgId} and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null
          and m.is_spam = false and m.is_automated = false and m.received_at > now() - interval '84 days'
        group by 1, 2
      ) s group by 1 order by 1`);
    return fillWeeks(rows.rows);
  });
}

export async function billMailSummary(ctx: OfficeContext, billId: string) {
  if (!can(ctx, "inbox.read") || !(await centerEnabled(ctx.orgId))) return null;
  return withTenant(tenantScope(ctx), async (tx) => {
    const [bill] = await tx.select({ identifier: bills.identifier }).from(bills).where(eq(bills.id, billId));
    if (!bill) return null;
    const rows = await tx.execute<{ people: number; support: number; oppose: number; in_district: number }>(sql`
      select count(*)::int as people,
        count(*) filter (where s.position = 'support')::int as support,
        count(*) filter (where s.position = 'oppose')::int as oppose,
        count(*) filter (where c.district_status = 'in_district')::int as in_district
      from (
        select distinct on (${PERSON}) p.position, m.contact_id
        from issue_positions p
        join email_messages m on m.id = p.message_id
        where p.organization_id = ${ctx.orgId} and p.target_type = 'bill' and p.status <> 'rejected'
          and (p.bill_id = ${billId} or (p.bill_id is null and p.bill_reference = ${bill.identifier}))
          and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null
        order by ${PERSON}, ${THEIR_WORD}
      ) s
      left join contacts c on c.id = s.contact_id`);
    const r = rows.rows[0];
    return r?.people ? { people: r.people, support: r.support, oppose: r.oppose, inDistrict: r.in_district, reference: bill.identifier } : null;
  });
}

const EXPORT_LIMIT = 20_000;

export async function mailForExport(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read", "records.export");
  const sensitive = can(ctx, "cases.read_sensitive");
  return withTenant(tenantScope(ctx), async (tx) => {
    const rows = await tx.execute<{
      received_at: Date | string; name: string | null; address: string; subject: string; message_types: string[]; is_internal: boolean; triage_status: string;
      district_status: string | null; issues: string | null; bills: string | null; answered_at: Date | string | null; form_letter: boolean;
    }>(sql`
      select m.received_at, coalesce(c.full_name, m.claimed_name, m.from_name) as name, coalesce(m.claimed_address, m.from_address) as address, m.subject,
        m.message_types, m.is_internal, m.triage_status, c.district_status,
        (select string_agg(distinct coalesce(t.label, l.issue_key), '; ') from message_issue_links l left join issue_taxonomy t on t.organization_id = l.organization_id and t.key = l.issue_key
          where l.message_id = m.id and l.status <> 'rejected' and l.issue_key like '%.%') as issues,
        (select string_agg(distinct p.bill_reference || case p.position when 'support' then ' (supports)' when 'oppose' then ' (opposes)' else '' end, '; ') from issue_positions p
          where p.message_id = m.id and p.target_type = 'bill' and p.status <> 'rejected') as bills,
        (select min(e.created_at) from message_events e where e.message_id = m.id and e.type = 'reply_sent') as answered_at,
        coalesce(m.template_cluster_id in ${CAMPAIGNS}, false) as form_letter
      from email_messages m
      left join contacts c on c.id = m.contact_id
      where m.organization_id = ${ctx.orgId} and m.direction = 'inbound' and m.triage_status <> 'archived' ${sensitive ? sql`` : sql`and m.is_sensitive = false`}
      order by m.received_at desc
      limit ${EXPORT_LIMIT}`);
    await audit(tx, ctx, "records.exported", "export", null, { what: "mail", rows: rows.rows.length });
    return rows.rows;
  });
}

export async function billPositionsForExport(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read", "records.export");
  const sensitive = can(ctx, "cases.read_sensitive");
  return withTenant(tenantScope(ctx), async (tx) => {
    const rows = await tx.execute<{
      reference: string; title: string | null; name: string | null; address: string; position: string; requested_action: string | null;
      district_status: string | null; form_letter: boolean; received_at: Date | string;
    }>(sql`
      select distinct on (p.bill_reference, ${PERSON}) p.bill_reference as reference, b.title, coalesce(c.full_name, m.claimed_name, m.from_name) as name, coalesce(m.claimed_address, m.from_address) as address,
        p.position, p.requested_action, c.district_status, coalesce(m.template_cluster_id in ${CAMPAIGNS}, false) as form_letter, m.received_at
      from issue_positions p
      join email_messages m on m.id = p.message_id
      left join contacts c on c.id = m.contact_id
      left join bills b on b.id = p.bill_id
      where p.organization_id = ${ctx.orgId} and p.target_type = 'bill' and p.status <> 'rejected'
        and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null ${sensitive ? sql`` : sql`and m.is_sensitive = false`}
      order by p.bill_reference, ${PERSON}, ${THEIR_WORD}
      limit ${EXPORT_LIMIT}`);
    await audit(tx, ctx, "records.exported", "export", null, { what: "bill positions", rows: rows.rows.length });
    return rows.rows;
  });
}

export async function aiReadingsToday(tx: Db, orgId: string) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [usage] = await tx.select({ n: count() }).from(classificationRuns)
    .where(and(
      eq(classificationRuns.organizationId, orgId), sql`${classificationRuns.output}->>'ai_status' = 'ok'`, gte(classificationRuns.createdAt, startOfDay),
    ));
  return usage.n;
}

export async function setupStatus(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [settings] = await tx.select().from(officeSettings).where(eq(officeSettings.organizationId, ctx.orgId));
    const [org] = await tx.select({ internalDomains: organizations.internalDomains, isDemo: organizations.isDemo }).from(organizations)
      .where(eq(organizations.id, ctx.orgId));
    const linked = await tx.select({ m: emailConnections, linkedBy: users.name }).from(emailConnections)
      .leftJoin(users, eq(users.id, emailConnections.authorizedBy)).where(eq(emailConnections.organizationId, ctx.orgId))
      .orderBy(asc(emailConnections.createdAt));
    const states = await tx.select().from(emailSyncState).where(eq(emailSyncState.organizationId, ctx.orgId));
    const errors = await tx.select().from(integrationErrors)
      .where(and(eq(integrationErrors.organizationId, ctx.orgId), sql`${integrationErrors.resolvedAt} is null`)).orderBy(desc(integrationErrors.lastSeenAt))
      .limit(8);
    const aiUsedToday = await aiReadingsToday(tx, ctx.orgId);
    return {
      settings, internalDomains: org.internalDomains, isDemo: org.isDemo || getEnv().APP_ENV === "demo",
      mailboxes: linked.map(({ m, linkedBy }) => ({
        id: m.id, provider: m.provider, emailAddress: m.emailAddress, status: m.status, authMode: m.authMode, selectedFolders: m.selectedFolders,
        sentFolder: m.sentFolder, importFrom: m.importFrom, lastSyncedAt: m.lastSyncedAt, lastError: m.lastError, authorizedAt: m.authorizedAt,
        authorizedBy: m.authorizedBy, linkedBy, mine: m.authorizedBy === ctx.userId, canManage: mayManageMailbox(ctx, m), sendingSince: m.sendEnabledAt,
        sendNeedsSignIn: !mailboxCanSend(m) && m.provider !== "imap",
        states: states.filter((s) => s.connectionId === m.id)
          .map((s) => ({ folderName: s.folderName, lastSuccessAt: s.lastSuccessAt, subscriptionExpiresAt: s.subscriptionExpiresAt })),
      })),
      errors, aiUsedToday, configured: integrationsConfigured(),
    };
  });
}

export async function checkMailNow(ctx: OfficeContext) {
  requirePermission(ctx, "inbox.read");
  const active = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({ id: emailConnections.id }).from(emailConnections)
      .where(and(eq(emailConnections.organizationId, ctx.orgId), eq(emailConnections.status, "active"))));
  const minute = Math.floor(Date.now() / 60_000);
  for (const c of active) await enqueue("mail.incremental", { connectionId: c.id }, { orgId: ctx.orgId, idempotencyKey: `check-now:${c.id}:${minute}` });
  return active.length;
}

export async function setReplySignature(ctx: OfficeContext, text: string) {
  requirePermission(ctx, "settings.manage");
  const signature = text.replace(/\r\n/g, "\n").trim();
  if (signature.length > 1000) throw new AppError("validation", "Keep the signature under 1,000 characters.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ replySignature: signature || null, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.reply_signature", "office_settings", ctx.orgId);
  });
}

export async function setAiProcessing(ctx: OfficeContext, enabled: boolean) {
  requirePermission(ctx, "settings.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings)
      .set({ aiEnabled: enabled, aiConsentAt: enabled ? new Date() : null, aiConsentBy: enabled ? ctx.userId : null, updatedAt: new Date() })
      .where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, enabled ? "settings.ai_enabled" : "settings.ai_disabled", "office_settings", ctx.orgId);
  });
}

export async function setAddressLookup(ctx: OfficeContext, enabled: boolean) {
  requirePermission(ctx, "settings.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ addressLookupEnabled: enabled, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, enabled ? "settings.address_lookup_on" : "settings.address_lookup_off", "office_settings", ctx.orgId);
    if (!enabled) return;
    const waiting = await tx.select({ id: contactAddresses.id }).from(contactAddresses)
      .where(and(eq(contactAddresses.organizationId, ctx.orgId), eq(contactAddresses.lookupStatus, "pending")));
    for (const a of waiting) await enqueue("contact.locate", { addressId: a.id }, { orgId: ctx.orgId, idempotencyKey: `locate:${a.id}:${Date.now()}` }, tx);
  });
}

export async function setFormLetterSettings(ctx: OfficeContext, input: { overlap: number; minWords: number }) {
  requirePermission(ctx, "settings.manage");
  if (!(input.overlap >= 0.5 && input.overlap <= 0.95)) throw new AppError("validation", "Shared wording must be between 50 and 95 percent.");
  if (!Number.isInteger(input.minWords) || input.minWords < 8 || input.minWords > 100) {
    throw new AppError("validation", "Shortest letter must be between 8 and 100 words.");
  }
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ templateOverlap: input.overlap, templateMinWords: input.minWords, updatedAt: new Date() })
      .where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.form_letters", "office_settings", ctx.orgId, input);
  });
}

export async function setAiGuidance(ctx: OfficeContext, text: string) {
  requirePermission(ctx, "settings.manage");
  const guidance = text.trim();
  if (guidance.length > 2000) throw new AppError("validation", "Keep these notes under 2,000 characters.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ aiGuidance: guidance || null, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.ai_guidance", "office_settings", ctx.orgId, { guidance });
  });
}

// Platform operation, never reachable from the web app.
export async function importSenderRules(orgId: string, values: string[], opts: { activate: boolean }) {
  const counts = { added: 0, skipped: 0, refused: [] as string[] };
  await withTenant({ orgId }, async (tx) => {
    for (const raw of values) {
      const { value, matchType, valid } = senderValue(raw);
      if (!value) continue;
      if (!valid || (matchType === "domain" && FREEMAIL.has(value))) {
        counts.refused.push(raw.trim());
        continue;
      }
      const [row] = await tx.insert(senderRules)
        .values({
          organizationId: orgId, kind: "hide", matchType, value, status: opts.activate ? "active" : "proposed", proposedBy: "system",
          reason: "Imported from the office's earlier system", confirmedAt: opts.activate ? new Date() : null,
        })
        .onConflictDoNothing().returning({ id: senderRules.id });
      if (row) counts.added++;
      else counts.skipped++;
    }
  });
  return counts;
}

export async function setInternalDomains(ctx: OfficeContext, domains: string[]) {
  requirePermission(ctx, "settings.manage");
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (clean.some((d) => FREEMAIL.has(d))) throw new AppError("validation", "A public mail service cannot be an office domain.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(organizations).set({ internalDomains: clean }).where(eq(organizations.id, ctx.orgId));
    await audit(tx, ctx, "settings.internal_domains", "organization", ctx.orgId);
  });
}
