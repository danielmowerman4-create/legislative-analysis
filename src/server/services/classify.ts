import { and, count, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import {
  agencyDirectory, bills, billSponsors, classificationFeedback, classificationRuns, contacts, emailMessages, issuePositions, issueTaxonomy, legislativeSessions,
  mailLedger, messageAsks, messageBillLinks, messageIssueLinks, officeSettings, organizations, reviewQueue, senderRules, tasks, type AutoAcceptThresholds,
} from "../db/schema";
import { runPipeline, inputHash } from "../classification/pipeline";
import { stripExternalBanner } from "../classification/preprocess";
import { sessionsInScope, STATE_NAME_BY_CODE, type BillCandidate } from "../classification/bills";
import { NO_SESSION, type SessionScope } from "../classification/bill-matching";
import { PIPELINE_VERSION, type ClassificationResult } from "../classification/schema";
import { enqueue } from "../jobs/queue";
import { getAiProvider } from "../ai/provider";
import { namesAnotherWriter } from "../email/sender-trust";
import { logger } from "../logger";
import { aiReadingsToday, campaignPeople } from "./center";
import { recordWriterAddress } from "./district";

const LEGISLATURE_DOMAINS: Record<string, string[]> = { GA: ["legis.ga.gov", "house.ga.gov", "senate.ga.gov"], CT: ["cga.ct.gov"], ZZ: ["legis.example.gov"] };

function stateDomainsOf(jurisdiction: string) {
  const name = STATE_NAME_BY_CODE[jurisdiction];
  return name && jurisdiction !== "ZZ"
    ? [`${jurisdiction.toLowerCase()}.gov`, `${name.toLowerCase().replace(/\s+/g, "")}.gov`, `state.${jurisdiction.toLowerCase()}.us`] : [];
}

const PROPOSE_HIDE_AFTER = 3;
const PROPOSE_RELAY_AFTER = 2;

const writesForSomeone = (msg: MessageRow, internalDomains: string[]) =>
  msg.direction === "inbound" && msg.senderTrust === "verified" && namesAnotherWriter(msg.fromAddress, msg.claimedAddress, internalDomains);

async function loadBillCandidates(orgId: string, jurisdiction: string, references: string[]): Promise<BillCandidate[]> {
  if (!references.length) return [];
  return withTenant({ orgId }, async (tx) => {
    const rows = await tx.select({
      id: bills.id, identifier: bills.identifier, jurisdictionCode: bills.jurisdictionCode, title: bills.title, summary: bills.officialSummary,
      subjects: bills.subjects, sessionIdentifier: legislativeSessions.identifier, sessionStart: legislativeSessions.startDate,
      sessionEnd: legislativeSessions.endDate,
    }).from(bills).innerJoin(legislativeSessions, eq(legislativeSessions.id, bills.sessionId))
      .where(and(eq(bills.jurisdictionCode, jurisdiction), inArray(bills.identifier, references)));
    const sponsors = rows.length
      ? await tx.select({ billId: billSponsors.billId, name: billSponsors.name }).from(billSponsors).where(inArray(billSponsors.billId, rows.map((r) => r.id)))
      : [];
    return rows.map((r) => ({ ...r, sponsorNames: sponsors.filter((s) => s.billId === r.id).map((s) => s.name) }));
  });
}

async function loadSessionScope(orgId: string, jurisdiction: string, at: Date): Promise<SessionScope> {
  return withTenant({ orgId }, async (tx) => {
    const sessions = await tx.select({
      id: legislativeSessions.id, identifier: legislativeSessions.identifier, startDate: legislativeSessions.startDate, endDate: legislativeSessions.endDate,
    }).from(legislativeSessions).where(eq(legislativeSessions.jurisdictionCode, jurisdiction));
    const inScope = sessionsInScope(sessions, at);
    if (!inScope.length) return NO_SESSION;
    const name = new Map(inScope.map((s) => [s.id, s.identifier]));
    const rows = await tx.select({
      id: bills.id, identifier: bills.identifier, billType: bills.billType, number: bills.number, title: bills.title, sessionId: bills.sessionId,
    }).from(bills).where(inArray(bills.sessionId, inScope.map((s) => s.id)));
    return { bills: rows.map(({ sessionId, ...b }) => ({ ...b, sessionIdentifier: name.get(sessionId)! })), sessions: inScope.map((s) => s.identifier) };
  });
}

// The AI call runs between two short transactions, never inside one.
export async function classifyMessage(orgId: string, messageId: string, opts: { triggeredBy?: string; rulesOnly?: boolean } = {}) {
  const loaded = await withTenant({ orgId }, async (tx) => {
    const [msg] = await tx.select().from(emailMessages).where(and(eq(emailMessages.id, messageId), eq(emailMessages.organizationId, orgId)));
    if (!msg) return null;
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    const [settings] = await tx.select().from(officeSettings).where(eq(officeSettings.organizationId, orgId));
    const taxonomy = await tx.select({
      key: issueTaxonomy.key, parentKey: issueTaxonomy.parentKey, label: issueTaxonomy.label, keywords: issueTaxonomy.keywords,
      isActive: issueTaxonomy.isActive,
    }).from(issueTaxonomy).where(eq(issueTaxonomy.organizationId, orgId));
    const agencies = await tx.select({ name: agencyDirectory.name, abbreviation: agencyDirectory.abbreviation, domains: agencyDirectory.domains })
      .from(agencyDirectory).where(and(eq(agencyDirectory.organizationId, orgId), eq(agencyDirectory.isActive, true)));
    const people = msg.templateClusterId ? await campaignPeople(tx, msg.templateClusterId) : 0;
    return { msg, org, settings, taxonomy, agencies, isFormLetter: people >= 2, aiUsedToday: await aiReadingsToday(tx, orgId) };
  });
  if (!loaded) return null;
  const { msg, org, settings, taxonomy, agencies, isFormLetter, aiUsedToday } = loaded;
  const thresholds: AutoAcceptThresholds = settings?.thresholds ?? { issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 };
  const input = {
    envelope: {
      fromAddress: msg.fromAddress, fromName: msg.fromName, subject: msg.subject, headers: msg.headers, labels: msg.labels, direction: msg.direction,
      sentAt: msg.sentAt, viaPlatform: msg.senderTrust === "relay", namesWriter: writesForSomeone(msg, org.internalDomains),
    },
    bodyText: msg.bodyText, bodyHtml: msg.bodyHtmlSanitized, formLetter: isFormLetter ? { personalNote: msg.personalNote } : undefined,
  };

  const started = Date.now();
  // Mail from a sender nobody could confirm never reaches the model.
  const confirmed = msg.senderTrust === "verified" || msg.senderTrust === "relay" || msg.direction === "outbound";
  const overLimit = aiUsedToday >= (settings?.aiDailyLimit ?? 0);
  const provider = await getAiProvider(Boolean(settings?.aiEnabled && settings.aiConsentAt));
  const ai = confirmed && !overLimit && !opts.rulesOnly ? provider : null;
  const aiWithheld = provider && confirmed && overLimit && !opts.rulesOnly
    ? "This office reached its daily limit for AI readings, so a person should read this." : null;
  let result: ClassificationResult;
  let pre: Awaited<ReturnType<typeof runPipeline>>["pre"];
  try {
    ({ result, pre } = await runPipeline(input, {
      taxonomy,
      officeJurisdiction: org.jurisdictionCode,
      // A domain counts only when the mail server confirmed the sender.
      office: confirmed
        ? {
          internalDomains: org.internalDomains, legislatureDomains: LEGISLATURE_DOMAINS[org.jurisdictionCode] ?? [], agencies,
          stateDomains: stateDomainsOf(org.jurisdictionCode),
        }
        : { internalDomains: [], legislatureDomains: [], agencies: agencies.map((a) => ({ ...a, domains: [] })) },
      thresholds,
      findBillCandidates: (refs) => loadBillCandidates(orgId, org.jurisdictionCode, refs),
      sessionScope: (at) => loadSessionScope(orgId, org.jurisdictionCode, at),
      ai,
      aiWithheld,
      officeGuidance: settings?.aiGuidance ?? null,
    }));
  } catch (error) {
    await withTenant({ orgId }, async (tx) => {
      await tx.insert(classificationRuns).values({
        organizationId: orgId, messageId, pipelineVersion: "error", mode: ai ? "rules+ai" : "rules", inputHash: inputHash(input), output: {}, status: "failed",
        error: (error as Error).message.slice(0, 500), triggeredBy: opts.triggeredBy,
      });
      await tx.update(emailMessages).set({ processingStatus: "failed", requiresReview: true }).where(eq(emailMessages.id, messageId));
      await tx.update(mailLedger).set({ disposition: "held", reason: "Stored, but it could not be read automatically. A person needs to read it." })
        .where(and(eq(mailLedger.organizationId, orgId), eq(mailLedger.messageId, messageId)));
    });
    throw error;
  }

  await withTenant({ orgId, userId: opts.triggeredBy }, async (tx) => {
    const [run] = await tx.insert(classificationRuns)
      .values({
        organizationId: orgId, messageId, pipelineVersion: result.pipeline_version, mode: result.mode, model: ai?.model ?? null, inputHash: inputHash(input),
        output: result as unknown as Record<string, unknown>, warnings: result.warnings, latencyMs: Date.now() - started, status: "succeeded",
        triggeredBy: opts.triggeredBy,
      })
      .returning({ id: classificationRuns.id });
    if (pre.substantive !== msg.substantiveText || pre.quoted !== msg.quotedText || pre.forwarded !== msg.forwardedText) {
      await tx.update(emailMessages)
        .set({
          substantiveText: pre.substantive, quotedText: pre.quoted, forwardedText: pre.forwarded,
          snippet: (pre.substantive || pre.forwarded || stripExternalBanner(msg.bodyText ?? "")).replace(/\s+/g, " ").slice(0, 200),
        })
        .where(eq(emailMessages.id, messageId));
    }
    await applyClassification(tx, orgId, msg, result, run.id, thresholds, org.internalDomains);
    await recordWriterAddress(tx, orgId, msg, pre);
  });
  logger.info("classify.done", { messageId, mode: result.mode, review: result.requires_staff_review });
  return result;
}

type MessageRow = typeof emailMessages.$inferSelect;

function reviewSubject(kind: string, reason: string) {
  if (kind === "issue") return reason.match(/"([^"]+)"/)?.[1] ?? reason;
  if (kind === "bill_match" || kind === "position") return reason.split(":")[0];
  return "";
}

const REREAD_PAGE = 200;

export async function rereadOlderReadings(orgId: string, after: string | null = null, readBefore: string | null = null) {
  const stale = readBefore ? sql`(coalesce(last.pipeline_version, '') <> ${PIPELINE_VERSION} or last.created_at < ${readBefore}::timestamptz)`
    : sql`coalesce(last.pipeline_version, '') <> ${PIPELINE_VERSION}`;
  const round = readBefore ? `:${readBefore}` : "";
  const ids = await withTenant({ orgId }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      select m.id from email_messages m
      left join lateral (select r.pipeline_version, r.mode, r.created_at from classification_runs r where r.message_id = m.id and r.status = 'succeeded' order by r.created_at desc limit 1) last on true
      where m.organization_id = ${orgId} and m.processing_status in ('processed', 'failed') ${after ? sql`and m.id > ${after}` : sql``}
        and ${stale} and coalesce(last.mode, 'rules') = 'rules'
      order by m.id
      limit ${REREAD_PAGE}`);
    for (const r of rows.rows) {
      await enqueue(
        "message.classify", { messageId: r.id, rulesOnly: true }, { orgId, idempotencyKey: `classify:${r.id}:${PIPELINE_VERSION}:reread${round}` }, tx,
      );
    }
    return rows.rows.map((r) => r.id);
  });
  const last = ids[ids.length - 1];
  if (ids.length === REREAD_PAGE) {
    await enqueue("mail.reread", { after: last, readBefore }, { orgId, idempotencyKey: `reread:${orgId}:${PIPELINE_VERSION}${round}:${last}` });
  }
  return { queued: ids.length };
}

const SENDER_KIND: Partial<Record<MessageRow["messageTypes"][number], "list" | "vendor" | "media" | "agency">> = {
  newsletter_automated: "list", vendor: "vendor", media: "media", government_agency: "agency",
};

async function settleContactKind(tx: Db, orgId: string, contactId: string) {
  const [contact] = await tx.select({ kind: contacts.kind }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)));
  if (!contact || !["person", "unknown", "list", "vendor", "media"].includes(contact.kind)) return;
  const mail = await tx.select({ types: emailMessages.messageTypes, confidence: emailMessages.messageTypeConfidence }).from(emailMessages)
    .where(and(
      eq(emailMessages.organizationId, orgId), eq(emailMessages.contactId, contactId), eq(emailMessages.direction, "inbound"),
      eq(emailMessages.processingStatus, "processed"),
    ));
  const kinds = new Set(mail.map((m) => (m.types[0] && (m.confidence[m.types[0]] ?? 0) >= 0.85 ? (SENDER_KIND[m.types[0]] ?? "person") : "person")));
  const kind = kinds.size === 1 ? [...kinds][0] : "person";
  const next = kind === "person" ? (contact.kind === "unknown" ? "unknown" : "person") : kind;
  if (next !== contact.kind) await tx.update(contacts).set({ kind: next }).where(eq(contacts.id, contactId));
}

// A (message, target) with a staff decision is locked against reprocessing.
async function applyClassification(
  tx: Db, orgId: string, msg: MessageRow, r: ClassificationResult, runId: string, th: AutoAcceptThresholds, internalDomains: string[] = [],
) {
  const messageId = msg.id;
  const lockedIssues = new Set((await tx.select({ k: messageIssueLinks.issueKey }).from(messageIssueLinks)
    .where(and(eq(messageIssueLinks.messageId, messageId), eq(messageIssueLinks.source, "staff")))).map((x) => x.k));
  const staffLinks = await tx.select({ k: messageBillLinks.reference, raw: messageBillLinks.rawReference }).from(messageBillLinks)
    .where(and(eq(messageBillLinks.messageId, messageId), eq(messageBillLinks.source, "staff")));
  const lockedBills = new Set(staffLinks.flatMap((x) => [x.k, x.raw]));
  const settledAs = new Map(staffLinks.filter((x) => x.raw !== x.k).map((x) => [x.raw, x.k]));
  const lockedPositions = new Set((await tx.select({ k: issuePositions.targetKey }).from(issuePositions)
    .where(and(eq(issuePositions.messageId, messageId), eq(issuePositions.source, "staff")))).map((x) => x.k));

  await tx.delete(reviewQueue).where(and(eq(reviewQueue.messageId, messageId), eq(reviewQueue.status, "open"), inArray(reviewQueue.kind, [
    "issue", "bill_match", "position", "message_type", "sensitive", "case_suggestion",
  ])));
  await tx.delete(messageIssueLinks)
    .where(and(
      eq(messageIssueLinks.messageId, messageId), sql`${messageIssueLinks.source} <> 'staff'`,
      sql`${messageIssueLinks.issueKey} not in (select t.key from issue_taxonomy t where t.organization_id = ${orgId} and t.is_active = false)`,
    ));
  await tx.delete(messageBillLinks).where(and(eq(messageBillLinks.messageId, messageId), sql`${messageBillLinks.source} <> 'staff'`));
  await tx.delete(issuePositions).where(and(eq(issuePositions.messageId, messageId), sql`${issuePositions.source} <> 'staff'`));

  const [typedByStaff] = await tx.select({ id: classificationFeedback.id }).from(classificationFeedback)
    .where(and(eq(classificationFeedback.messageId, messageId), eq(classificationFeedback.field, "message_type"))).limit(1);
  const closedReviews = await tx.select({ kind: reviewQueue.kind, reason: reviewQueue.reason }).from(reviewQueue)
    .where(and(eq(reviewQueue.messageId, messageId), ne(reviewQueue.status, "open")));
  const settledAsks = await tx.select({ kind: messageAsks.kind, summary: messageAsks.summary, quote: messageAsks.quote }).from(messageAsks)
    .where(and(eq(messageAsks.messageId, messageId), sql`(${messageAsks.status} <> 'open' or ${messageAsks.source} = 'staff')`));
  const [readBefore] = await tx.select({ id: classificationRuns.id }).from(classificationRuns)
    .where(and(eq(classificationRuns.messageId, messageId), eq(classificationRuns.status, "succeeded"), ne(classificationRuns.id, runId))).limit(1);

  const types = typedByStaff && msg.messageTypes.length ? msg.messageTypes : r.message_type.map((t) => t.type);
  const isPolicy = types.includes("constituent_policy") || types.includes("organization");
  const nonCorrespondence = (!typedByStaff &&
      r.message_type.some((t) => ["newsletter_automated", "spam", "legislative_staff"].includes(t.type) && t.confidence >= 0.85)) ||
    msg.isInternal || msg.direction === "outbound";
  const review: (typeof reviewQueue.$inferInsert)[] = [];

  for (const i of r.issues) {
    if (lockedIssues.has(i.taxonomy_id)) continue;
    const isArea = !i.taxonomy_id.includes(".");
    const needsReview = !isArea && i.confidence < th.issue && (isPolicy || types.includes("constituent_service"));
    const [link] = await tx.insert(messageIssueLinks)
      .values({
        organizationId: orgId, messageId, issueKey: i.taxonomy_id, confidence: i.confidence, source: i.source,
        status: needsReview ? "needs_review" : "provisional", evidence: i.evidence, runId,
      })
      .returning({ id: messageIssueLinks.id });
    if (needsReview) {
      review.push({
        organizationId: orgId, kind: "issue", messageId, entityType: "message_issue_link", entityId: link.id,
        reason: `Issue "${i.taxonomy_id}" below auto-accept confidence (${i.confidence.toFixed(2)}).`, priority: 30,
      });
    }
  }

  const billIdByRef = new Map<string, string | null>();
  for (const b of r.bill_references) {
    if (lockedBills.has(b.reference) || lockedBills.has(b.raw_reference)) continue;
    const autoAccept = b.resolution_status === "resolved" && b.confidence >= th.billMatch && b.bill_id;
    const needsReview = !nonCorrespondence && !autoAccept &&
      (b.resolution_status === "ambiguous" || b.resolution_status === "resolved" || (b.resolution_status === "unmatched" && isPolicy));
    const [link] = await tx
      .insert(messageBillLinks)
      .values({
        organizationId: orgId,
        messageId,
        reference: b.reference,
        rawReference: b.raw_reference,
        // Only an auto-accepted match sets bill_id; the rest wait for staff.
        billId: autoAccept ? b.bill_id : null,
        resolution: b.resolution_status,
        candidateBillIds: b.candidate_bill_ids,
        resolutionNotes: b.notes,
        confidence: b.confidence,
        source: "rule",
        status: autoAccept ? "provisional" : needsReview ? "needs_review" : "provisional",
        evidence: b.evidence,
        runId,
      })
      .returning({ id: messageBillLinks.id });
    billIdByRef.set(b.reference, autoAccept ? b.bill_id : null);
    if (needsReview) {
      review.push({
        organizationId: orgId, kind: "bill_match", messageId, entityType: "message_bill_link", entityId: link.id, reason: `${b.reference}: ${b.notes}`,
        priority: b.resolution_status === "ambiguous" ? 70 : 55, payload: { candidates: b.candidate_bill_ids },
      });
    }
  }
  const staffBills = await tx.select({ reference: messageBillLinks.reference, billId: messageBillLinks.billId }).from(messageBillLinks)
    .where(and(eq(messageBillLinks.messageId, messageId), eq(messageBillLinks.source, "staff")));
  for (const s of staffBills) billIdByRef.set(s.reference, s.billId);

  for (const original of r.positions) {
    const billReference = original.bill_reference
      ? (settledAs.get(r.bill_references.find((b) => b.reference === original.bill_reference)?.raw_reference ?? original.bill_reference) ??
        original.bill_reference)
      : null;
    const p = { ...original, bill_reference: billReference };
    const targetKey = p.target_type === "bill" ? `bill:${p.bill_reference}` : `issue:${p.issue_id}`;
    if (lockedPositions.has(targetKey)) continue;
    const hasBills = r.bill_references.length > 0;
    const reviewable = isPolicy &&
      (p.target_type === "bill" ? p.position === "mixed" || p.position === "unclear" || p.confidence < th.position
        : !hasBills && (p.position === "mixed" || (p.position !== "unclear" && p.position !== "neutral" && p.confidence < th.position)));
    const [pos] = await tx.insert(issuePositions)
      .values({
        organizationId: orgId, messageId, contactId: msg.contactId, targetKey, targetType: p.target_type, issueKey: p.issue_id, billReference: p.bill_reference,
        billId: p.bill_reference ? (billIdByRef.get(p.bill_reference) ?? null) : null, position: p.position, requestedAction: p.requested_action,
        confidence: p.confidence, source: p.source, status: reviewable ? "needs_review" : "provisional", evidence: p.evidence, runId,
      })
      .returning({ id: issuePositions.id });
    if (reviewable) {
      review.push({
        organizationId: orgId, kind: "position", messageId, entityType: "issue_position", entityId: pos.id,
        reason: `${p.bill_reference ?? p.issue_id}: ${p.notes ?? p.position}`, priority: p.target_type === "bill" ? 60 : 40,
      });
    }
  }

  if (r.sensitive.flagged) {
    review.push({
      organizationId: orgId, kind: "sensitive", messageId, entityType: "email_message", entityId: messageId,
      reason: `Sensitive content (${r.sensitive.categories.join(", ")}). Handle under the office's confidentiality rules.`,
      priority: r.sensitive.categories.includes("self_harm") ? 100 : 80,
    });
  }
  if (r.case_suggestion?.suggested) {
    review.push({
      organizationId: orgId, kind: "case_suggestion", messageId, entityType: "email_message", entityId: messageId,
      reason: `Suggested case: ${r.case_suggestion.category}${r.case_suggestion.agency ? ` (${r.case_suggestion.agency})` : ""}.`, priority: 65,
      payload: r.case_suggestion as unknown as Record<string, unknown>,
    });
  }
  if (!typedByStaff && r.message_type[0].confidence < th.messageType && types[0] !== "newsletter_automated") {
    review.push({
      organizationId: orgId, kind: "message_type", messageId, entityType: "email_message_type", entityId: messageId,
      reason: `Message type uncertain (${types.join(", ")}).`, priority: 20,
    });
  }

  const open = review.filter((x) => !closedReviews.some((c) => c.kind === x.kind && reviewSubject(c.kind, c.reason) === reviewSubject(x.kind, x.reason)));
  if (open.length) await tx.insert(reviewQueue).values(open).onConflictDoNothing();

  await tx.delete(tasks).where(and(eq(tasks.messageId, messageId), eq(tasks.source, "ai_suggested"), eq(tasks.status, "suggested")));
  for (const c of r.commitments) {
    await tx.insert(tasks).values({
      organizationId: orgId, title: c.text.slice(0, 200), status: "suggested", source: "ai_suggested", messageId,
      dueAt: c.due_hint ? new Date(c.due_hint) : null, evidence: [c.evidence],
    });
  }

  await tx.delete(messageAsks).where(and(eq(messageAsks.messageId, messageId), eq(messageAsks.status, "open"), sql`${messageAsks.source} <> 'staff'`));
  const wholeLetter = new Set(["casework", "meeting", "safety", "deadline"]);
  const newAsks = r.asks.filter((a) =>
    !settledAsks.some((s) => s.kind === a.kind && (wholeLetter.has(a.kind) || s.summary === a.summary || s.quote === a.evidence.text)));
  if (newAsks.length) {
    await tx.insert(messageAsks).values(newAsks.map((a) => ({
      organizationId: orgId, messageId, kind: a.kind, summary: a.summary, quote: a.evidence.text, quoteStart: a.evidence.start, quoteEnd: a.evidence.end,
      source: a.source, urgency: a.urgency, dueAt: a.due_at ? new Date(a.due_at) : null,
    })));
  }

  const [entry] = await tx.select({ id: mailLedger.id, disposition: mailLedger.disposition, restoredAt: mailLedger.restoredAt }).from(mailLedger)
    .where(and(eq(mailLedger.organizationId, orgId), eq(mailLedger.messageId, messageId), sql`${mailLedger.disposition} <> 'duplicate'`)).limit(1);
  const kept = Boolean(entry?.restoredAt) || Boolean(typedByStaff);
  const screens = kept ? [] : r.message_type.filter((t) => (t.type === "newsletter_automated" || t.type === "spam") && t.confidence >= 0.85);
  const automated = screens.some((t) => t.type === "newsletter_automated");
  const spam = screens.some((t) => t.type === "spam");
  const setAside = msg.triageStatus === "new" && screens.length > 0;
  const broughtBack = !kept && entry?.disposition === "screened" && msg.triageStatus === "archived" && screens.length === 0;
  const salesOrPress = r.message_type.some((t) => (t.type === "vendor" || t.type === "media") && !t.signals.includes("AI"));
  const named = writesForSomeone(msg, internalDomains)
    ? await tx.selectDistinct({ address: sql<string>`lower(${emailMessages.claimedAddress})` }).from(emailMessages)
      .where(and(
        eq(emailMessages.organizationId, orgId), eq(emailMessages.fromAddress, msg.fromAddress), eq(emailMessages.senderTrust, "verified"),
        isNotNull(emailMessages.claimedAddress),
      ))
      .limit(50)
    : [];
  if (named.filter((w) => namesAnotherWriter(msg.fromAddress, w.address, internalDomains)).length >= PROPOSE_RELAY_AFTER) {
    await tx.insert(senderRules)
      .values({
        organizationId: orgId, kind: "relay", matchType: "address", value: msg.fromAddress, status: "proposed", proposedBy: "system",
        reason: "Its mail names different people as the writers.",
      })
      .onConflictDoNothing();
  } else if (msg.senderTrust !== "relay" && (msg.headers["list-id"] || msg.headers["list-unsubscribe"] || salesOrPress)) {
    const [sent] = await tx.select({ n: count() }).from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.fromAddress, msg.fromAddress)));
    if (sent.n >= PROPOSE_HIDE_AFTER) {
      await tx.insert(senderRules)
        .values({
          organizationId: orgId, kind: "hide", matchType: "address", value: msg.fromAddress, status: "proposed", proposedBy: "system",
          reason: `${sent.n} messages from this address that look like ${salesOrPress ? "sales or press outreach" : "a mailing list"}.`,
        })
        .onConflictDoNothing();
    }
  }
  const priority = r.urgency.level === "urgent" || r.sensitive.categories.includes("self_harm") ? "urgent"
    : r.sensitive.flagged || types[0] === "constituent_service" || r.urgency.level === "soon" ? "high" : automated || spam ? "low" : "normal";
  await tx.update(emailMessages)
    .set({
      ...(typedByStaff ? {}
        : {
          messageTypes: types, messageTypeConfidence: Object.fromEntries(r.message_type.map((t) => [t.type, t.confidence])), isAutomated: automated,
          isSpam: spam,
        }),
      requestedActions: r.requested_actions, ...(msg.summarySource === "staff" ? {} : { summary: r.summary, summarySource: r.summary_source }),
      isSensitive: r.sensitive.flagged, language: r.language, priority,
      requiresReview: open.length > 0 || (readBefore ? msg.requiresReview && r.requires_staff_review : r.requires_staff_review) ||
        msg.senderTrust === "failed" || msg.senderTrust === "unverified",
      urgencyReason: r.urgency.reason, dueAt: r.urgency.due_at ? new Date(r.urgency.due_at) : null, processingStatus: "processed",
      triageStatus: setAside ? "archived" : broughtBack ? "new" : msg.triageStatus,
    })
    .where(eq(emailMessages.id, messageId));
  if (broughtBack && entry) {
    await tx.update(mailLedger).set({ disposition: "filed", reason: "Read again and returned to the mail." }).where(eq(mailLedger.id, entry.id));
  }
  if (msg.contactId && msg.direction === "inbound") await settleContactKind(tx, orgId, msg.contactId);
  if (setAside && entry?.disposition === "filed") {
    const marks = screens.flatMap((t) => t.signals).join(", ");
    await tx.update(mailLedger).set({ disposition: "screened", reason: `Looks like ${spam ? "spam" : "a mailing list or automatic mail"} (${marks}).` })
      .where(eq(mailLedger.id, entry.id));
  }
}

