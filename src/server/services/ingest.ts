import { and, arrayOverlaps, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import {
  agencyDirectory, contactEmails, contacts, emailAttachments, emailConnections, emailMessages, emailParticipants, emailThreads, mailLedger, officeSettings,
  organizations, reviewQueue, senderRules, templateClusters, type LedgerDisposition, type SenderTrust,
} from "../db/schema";
import { normalizeSubject, type NormalizedMessage } from "../email/normalize";
import { inspectAttachment } from "../email/attachments";
import { assessSender, matchesSenderRule, type MailSource } from "../email/sender-trust";
import { imapSecret } from "../email/connections";
import { preprocess, stripExternalBanner } from "../classification/preprocess";
import { minShinglesFor, narrowCanonical, overlap, personalNote, shingles, sketchOf, templateFingerprint } from "../classification/templates";
import { domainOf } from "../classification/rules";
import { PIPELINE_VERSION } from "../classification/schema";
import { enqueue } from "../jobs/queue";
import { recordReply } from "./answered";

type IngestResult = { messageId: string; duplicate: boolean; contactId: string | null; disposition: LedgerDisposition };

const domainIn = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

export const ledgerKey = (connectionId: string | null, providerMessageId: string) => `${connectionId ?? "none"}:${providerMessageId}`;
const sourceKeyFor = (connectionId: string | null, m: NormalizedMessage) =>
  (m.providerMessageId ? ledgerKey(connectionId, m.providerMessageId) : `rfc:${m.rfcMessageId ?? `${m.from.address}|${m.sentAt.toISOString()}`}`);

type Settle = { disposition: LedgerDisposition; reason: string | null; messageId: string | null; ruleId?: string | null };

async function settle(tx: Db, orgId: string, connectionId: string | null, m: NormalizedMessage, s: Settle) {
  const fields = {
    disposition: s.disposition, reason: s.reason, messageId: s.messageId, ruleId: s.ruleId ?? null, fromAddress: m.from.address,
    subject: m.subject.slice(0, 300), receivedAt: m.receivedAt, lastError: null, settledAt: new Date(),
  };
  await tx.insert(mailLedger)
    .values({ organizationId: orgId, connectionId, sourceKey: sourceKeyFor(connectionId, m), providerMessageId: m.providerMessageId, ...fields })
    .onConflictDoUpdate({ target: [mailLedger.organizationId, mailLedger.sourceKey], set: { ...fields, attempts: sql`${mailLedger.attempts} + 1` } });
}

export async function recordLedgerFailure(orgId: string, connectionId: string, providerMessageId: string, reason: string) {
  await withTenant({ orgId }, (tx) =>
    tx.insert(mailLedger)
      .values({
        organizationId: orgId, connectionId, sourceKey: ledgerKey(connectionId, providerMessageId), providerMessageId, disposition: "failed", reason,
        lastError: reason,
      })
      .onConflictDoUpdate({
        target: [mailLedger.organizationId, mailLedger.sourceKey],
        set: { disposition: "failed", reason, lastError: reason, attempts: sql`${mailLedger.attempts} + 1` },
      }));
}

export async function recordLedgerOwed(orgId: string, connectionId: string, providerMessageIds: string[], reason: string) {
  if (!providerMessageIds.length) return;
  await withTenant({ orgId }, (tx) =>
    tx.insert(mailLedger)
      .values(providerMessageIds.map((providerMessageId) => ({
        organizationId: orgId, connectionId, sourceKey: ledgerKey(connectionId, providerMessageId), providerMessageId, disposition: "failed" as const, reason,
        lastError: reason,
      })))
      .onConflictDoNothing({ target: [mailLedger.organizationId, mailLedger.sourceKey] }));
}

async function findThread(tx: Db, orgId: string, connectionId: string | null, m: NormalizedMessage): Promise<string> {
  if (m.providerThreadId && connectionId) {
    const [t] = await tx.select({ id: emailThreads.id }).from(emailThreads)
      .where(and(eq(emailThreads.connectionId, connectionId), eq(emailThreads.providerThreadId, m.providerThreadId))).limit(1);
    if (t) return t.id;
  }
  const refs = [m.inReplyTo, ...m.references].filter((x): x is string => Boolean(x));
  const [parent] = refs.length
    ? await tx.select({ threadId: emailMessages.threadId }).from(emailMessages)
      .where(and(eq(emailMessages.organizationId, orgId), inArray(emailMessages.rfcMessageId, refs), isNotNull(emailMessages.threadId))).limit(1)
    : [];
  const [child] = m.rfcMessageId
    ? await tx.select({ threadId: emailMessages.threadId }).from(emailMessages)
      .where(and(
        eq(emailMessages.organizationId, orgId), isNotNull(emailMessages.threadId),
        or(eq(emailMessages.inReplyTo, m.rfcMessageId), sql`${m.rfcMessageId} = any(${emailMessages.references})`),
      ))
      .limit(1)
    : [];
  const above = parent?.threadId ?? null;
  const below = child?.threadId ?? null;
  if (above && below && above !== below) return joinThreads(tx, orgId, above, below);
  if (above ?? below) return (above ?? below)!;
  const subj = normalizeSubject(m.subject);
  const counterpart = m.direction === "inbound" ? m.from.address : (m.to[0]?.address ?? "");
  if (subj && counterpart && /^(re|fw|fwd):/i.test(m.subject.trim())) {
    const [t] = await tx.select({ id: emailThreads.id }).from(emailThreads).innerJoin(emailMessages, eq(emailMessages.threadId, emailThreads.id))
      .innerJoin(emailParticipants, eq(emailParticipants.messageId, emailMessages.id))
      .where(and(
        eq(emailThreads.organizationId, orgId), eq(emailThreads.subjectNormalized, subj), eq(emailParticipants.address, counterpart),
        gte(emailThreads.lastMessageAt, new Date(m.sentAt.getTime() - 30 * 86400_000)),
      ))
      .orderBy(desc(emailThreads.lastMessageAt)).limit(1);
    if (t) return t.id;
  }
  const [created] = await tx.insert(emailThreads)
    .values({
      organizationId: orgId, connectionId, providerThreadId: m.providerThreadId, subjectNormalized: subj, firstMessageAt: m.sentAt, lastMessageAt: m.sentAt,
    })
    .onConflictDoNothing().returning({ id: emailThreads.id });
  if (created) return created.id;
  const [again] = await tx.select({ id: emailThreads.id }).from(emailThreads)
    .where(and(eq(emailThreads.connectionId, connectionId!), eq(emailThreads.providerThreadId, m.providerThreadId!))).limit(1);
  return again.id;
}

async function joinThreads(tx: Db, orgId: string, a: string, b: string): Promise<string> {
  const rows = await tx.select({ id: emailThreads.id, providerThreadId: emailThreads.providerThreadId }).from(emailThreads)
    .where(and(eq(emailThreads.organizationId, orgId), inArray(emailThreads.id, [a, b])));
  const numbered = rows.filter((r) => r.providerThreadId);
  if (rows.length < 2 || numbered.length === 2) return a;
  const keep = numbered[0]?.id ?? a;
  const drop = keep === a ? b : a;
  await tx.update(emailMessages).set({ threadId: keep }).where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.threadId, drop)));
  const [gone] = await tx.delete(emailThreads).where(eq(emailThreads.id, drop))
    .returning({ n: emailThreads.messageCount, first: emailThreads.firstMessageAt, last: emailThreads.lastMessageAt });
  if (gone) {
    await tx.update(emailThreads)
      .set({
        messageCount: sql`${emailThreads.messageCount} + ${gone.n}`,
        firstMessageAt: gone.first
          ? sql`least(coalesce(${emailThreads.firstMessageAt}, ${gone.first.toISOString()}::timestamptz), ${gone.first.toISOString()}::timestamptz)`
          : emailThreads.firstMessageAt,
        lastMessageAt: gone.last
          ? sql`greatest(coalesce(${emailThreads.lastMessageAt}, ${gone.last.toISOString()}::timestamptz), ${gone.last.toISOString()}::timestamptz)`
          : emailThreads.lastMessageAt,
      })
      .where(eq(emailThreads.id, keep));
  }
  return keep;
}

// Match by confirmed address only; names never cause a match or a merge.
export async function matchContact(
  tx: Db, orgId: string, address: string, name: string | null, office: { internalDomains: string[]; agencyDomains: string[] }, messageId: string,
  source: "inbound_message" | "relay",
) {
  const [existing] = await tx.select({
    contactId: contactEmails.contactId, isShared: contactEmails.isShared, fullName: contacts.fullName, mergedIntoId: contacts.mergedIntoId,
  }).from(contactEmails).innerJoin(contacts, eq(contacts.id, contactEmails.contactId))
    .where(and(eq(contactEmails.organizationId, orgId), eq(contactEmails.email, address))).limit(1);
  if (existing) {
    const contactId = existing.mergedIntoId ?? existing.contactId;
    const nameDiffers = name && existing.fullName && name.toLowerCase().replace(/[^a-z]/g, "") !== existing.fullName.toLowerCase().replace(/[^a-z]/g, "");
    if (existing.isShared || nameDiffers) {
      await tx.insert(reviewQueue)
        .values({
          organizationId: orgId, kind: "contact_match", messageId, entityType: "email_message", entityId: messageId,
          reason: existing.isShared ? "Shared household address: confirm which person wrote this."
            : `Known address, different name ("${name}" vs "${existing.fullName}").`,
          priority: 40, payload: { contactId, address },
        })
        .onConflictDoNothing();
    }
    if (source === "inbound_message") {
      await tx.update(contactEmails).set({ verified: true, verifiedSource: "inbound_message" })
        .where(and(eq(contactEmails.organizationId, orgId), eq(contactEmails.email, address), eq(contactEmails.verified, false)));
    }
    return contactId;
  }
  const domain = domainOf(address);
  const kind = domainIn(domain, office.internalDomains) ? "staff" : domainIn(domain, office.agencyDomains) ? "agency" : name ? "person" : "unknown";
  const parts = (name ?? "").split(/\s+/).filter(Boolean);
  const [c] = await tx.insert(contacts)
    .values({
      organizationId: orgId, kind, fullName: name, firstName: parts.length > 1 ? parts[0] : null, lastName: parts.length > 1 ? parts[parts.length - 1] : null,
      firstSeenAt: new Date(),
    })
    .returning({ id: contacts.id });
  await tx.insert(contactEmails)
    .values({ organizationId: orgId, contactId: c.id, email: address, isPrimary: true, verified: source === "inbound_message", verifiedSource: source })
    .onConflictDoNothing();
  return c.id;
}

export async function settleDuplicate(
  tx: Db, orgId: string, m: { id: string; fromAddress: string; sentAt: Date; substantive: string; trust: SenderTrust; claimedAddress: string | null },
) {
  const samePerson = m.trust === "relay" ? (m.claimedAddress ? sql`lower(${emailMessages.claimedAddress}) = ${m.claimedAddress.toLowerCase()}` : null)
    : and(eq(emailMessages.fromAddress, m.fromAddress), sql`${emailMessages.senderTrust} <> 'relay'`);
  if (!samePerson || m.substantive.length <= 20) return null;
  const week = 7 * 86400_000;
  const twins = await tx.select({
    id: emailMessages.id, sentAt: emailMessages.sentAt, trust: emailMessages.senderTrust, duplicateOfId: emailMessages.duplicateOfId,
  }).from(emailMessages)
    .where(and(
      eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "inbound"), samePerson, eq(emailMessages.substantiveText, m.substantive),
      gte(emailMessages.sentAt, new Date(m.sentAt.getTime() - week)), lte(emailMessages.sentAt, new Date(m.sentAt.getTime() + week)),
      sql`${emailMessages.id} <> ${m.id}`,
    ))
    .orderBy(emailMessages.sentAt, emailMessages.id);
  // Ties at the same instant break by id, so a rerun gives the same answer.
  const before = (t: { id: string; sentAt: Date }) => t.sentAt.getTime() < m.sentAt.getTime() || (t.sentAt.getTime() === m.sentAt.getTime() && t.id < m.id);
  // An unconfirmed copy never stands in for a confirmed one.
  const isConfirmed = (trust: string) => trust === "verified" || trust === "relay";
  const mayStandFor = (original: string, copy: string) => isConfirmed(original) || !isConfirmed(copy);
  const first = twins.find((t) => before(t) && mayStandFor(t.trust, m.trust));
  const duplicateOfId = first ? (first.duplicateOfId ?? first.id) : null;
  const later = twins.filter((t) => !before(t) && mayStandFor(m.trust, t.trust)).map((t) => t.id);
  if (later.length) await tx.update(emailMessages).set({ duplicateOfId: duplicateOfId ?? m.id }).where(inArray(emailMessages.id, later));
  return duplicateOfId;
}

async function assignTemplateCluster(
  tx: Db, orgId: string, messageId: string, substantive: string, sentAt: Date, settings: { overlap: number; minWords: number },
) {
  const minShingles = minShinglesFor(settings.minWords);
  const fp = templateFingerprint(substantive, settings.minWords);
  if (!fp) return { clusterId: null, note: null };
  const own = shingles(substantive);
  const candidates = await tx.select({ id: templateClusters.id, canonical: templateClusters.canonicalShingles, count: templateClusters.messageCount })
    .from(templateClusters)
    .where(and(
      eq(templateClusters.organizationId, orgId), gte(templateClusters.lastSeenAt, new Date(sentAt.getTime() - 90 * 86400_000)),
      arrayOverlaps(templateClusters.sketch, sketchOf(own)),
    ));
  const scored = candidates.map((c) => ({ ...c, score: overlap(c.canonical, own, minShingles) })).sort((a, b) => b.score - a.score);
  const hit = scored[0] && scored[0].score >= settings.overlap ? scored[0] : null;
  if (!hit) {
    const [created] = await tx.insert(templateClusters)
      .values({
        organizationId: orgId, fingerprint: fp, messageCount: 1, firstSeenAt: sentAt, lastSeenAt: sentAt, sampleMessageId: messageId, canonicalShingles: own,
        sketch: sketchOf(own),
      })
      .onConflictDoUpdate({
        target: [templateClusters.organizationId, templateClusters.fingerprint],
        set: {
          messageCount: sql`${templateClusters.messageCount} + 1`,
          lastSeenAt: sql`greatest(${templateClusters.lastSeenAt}, ${sentAt.toISOString()}::timestamptz)`,
        },
      })
      .returning({ id: templateClusters.id });
    return { clusterId: created.id, note: null };
  }
  const canonical = narrowCanonical(hit.canonical, own, minShingles);
  const count = hit.count + 1;
  await tx.update(templateClusters)
    .set({
      messageCount: count, canonicalShingles: canonical, sketch: sketchOf(canonical),
      lastSeenAt: sql`greatest(${templateClusters.lastSeenAt}, ${sentAt.toISOString()}::timestamptz)`,
    })
    .where(eq(templateClusters.id, hit.id));
  if (count <= 5) {
    const earlier = await tx.select({ id: emailMessages.id, text: emailMessages.substantiveText }).from(emailMessages)
      .where(eq(emailMessages.templateClusterId, hit.id));
    for (const e of earlier) await tx.update(emailMessages).set({ personalNote: personalNote(e.text, canonical) }).where(eq(emailMessages.id, e.id));
  }
  return { clusterId: hit.id, note: personalNote(substantive, canonical) };
}

export async function officeDomains(tx: Db, orgId: string) {
  const [org] = await tx.select({ internalDomains: organizations.internalDomains }).from(organizations).where(eq(organizations.id, orgId));
  const agencies = await tx.select({ domains: agencyDirectory.domains }).from(agencyDirectory).where(eq(agencyDirectory.organizationId, orgId));
  return { internalDomains: org.internalDomains, agencyDomains: agencies.flatMap((a) => a.domains) };
}

// Idempotent on (connection, provider id) and (office, Message-ID, direction).
export async function ingestMessage(orgId: string, connectionId: string | null, m: NormalizedMessage): Promise<IngestResult> {
  const inspected = m.attachments.map((a) => ({ a, d: inspectAttachment(a.filename, a.declaredType, a.content) }));

  return withTenant({ orgId }, async (tx) => {
    const dupConds = [
      m.providerMessageId && connectionId ? and(eq(emailMessages.connectionId, connectionId), eq(emailMessages.providerMessageId, m.providerMessageId))
        : undefined,
      m.rfcMessageId ? and(eq(emailMessages.organizationId, orgId), eq(emailMessages.rfcMessageId, m.rfcMessageId), eq(emailMessages.direction, m.direction))
        : undefined,
    ].filter(Boolean);
    const sameDelivery = async (dup: { id: string; contactId: string | null }): Promise<IngestResult> => {
      const [row] = await tx.select({ disposition: mailLedger.disposition, messageId: mailLedger.messageId }).from(mailLedger)
        .where(and(eq(mailLedger.organizationId, orgId), eq(mailLedger.sourceKey, sourceKeyFor(connectionId, m))));
      if (row?.messageId === dup.id && row.disposition !== "failed" && row.disposition !== "pending") {
        return { messageId: dup.id, duplicate: true, contactId: dup.contactId, disposition: row.disposition };
      }
      await settle(tx, orgId, connectionId, m, { disposition: "duplicate", reason: "The same message was already stored.", messageId: dup.id });
      return { messageId: dup.id, duplicate: true, contactId: dup.contactId, disposition: "duplicate" };
    };
    const findDup = async () =>
      (await tx.select({ id: emailMessages.id, contactId: emailMessages.contactId }).from(emailMessages).where(or(...dupConds)).limit(1))[0];
    if (dupConds.length) {
      const dup = await findDup();
      if (dup) return sameDelivery(dup);
    }

    const office = await officeDomains(tx, orgId);
    const rules = await tx.select().from(senderRules).where(and(eq(senderRules.organizationId, orgId), eq(senderRules.status, "active")));
    const inbound = m.direction === "inbound";

    const [formLetterSettings] = await tx.select({ overlap: officeSettings.templateOverlap, minWords: officeSettings.templateMinWords }).from(officeSettings)
      .where(eq(officeSettings.organizationId, orgId));
    const pre = preprocess({ bodyText: m.bodyText, bodyHtml: m.bodyHtmlSanitized });
    const [linked] = connectionId
      ? await tx.select({ provider: emailConnections.provider, refreshTokenEnc: emailConnections.refreshTokenEnc }).from(emailConnections)
        .where(eq(emailConnections.id, connectionId))
      : [];
    const source: MailSource | null = linked
      ? { provider: linked.provider, imapHost: linked.provider === "imap" && linked.refreshTokenEnc ? (imapSecret(linked).host ?? null) : null } : null;
    const sender = assessSender({
      from: m.from, replyTo: m.replyTo, headers: m.headers, relayRules: rules.filter((r) => r.kind === "relay"), internalDomains: office.internalDomains,
      body: [pre.substantive, pre.signature].filter(Boolean).join("\n"), source,
    });
    const hideRule = inbound ? rules.find((r) => r.kind === "hide" && matchesSenderRule(m.from.address, r)) : undefined;
    const held = inbound && !hideRule && (sender.trust === "failed" || sender.trust === "unverified");

    const threadId = await findThread(tx, orgId, connectionId, m);
    const isInternal = inbound && sender.isInternal;

    const [msg] = await tx.insert(emailMessages)
      .values({
        organizationId: orgId, connectionId, providerMessageId: m.providerMessageId, rfcMessageId: m.rfcMessageId, inReplyTo: m.inReplyTo,
        references: m.references, threadId, direction: m.direction, labels: m.labels, subject: m.subject, fromAddress: m.from.address, fromName: m.from.name,
        sentAt: m.sentAt, receivedAt: m.receivedAt,
        snippet: (pre.substantive || pre.forwarded || stripExternalBanner(m.bodyText)).replace(/\s+/g, " ").slice(0, 200), bodyText: m.bodyText,
        bodyHtmlSanitized: m.bodyHtmlSanitized, substantiveText: pre.substantive, quotedText: pre.quoted, forwardedText: pre.forwarded, language: pre.language,
        headers: m.headers, rawSizeBytes: m.rawSizeBytes, hasAttachments: m.attachments.some((a) => !a.isInline), isInternal,
        triageStatus: !inbound ? "done" : hideRule ? "archived" : "new", isRead: !inbound, senderTrust: inbound ? sender.trust : "verified",
        senderTrustDetail: sender.detail, claimedAddress: sender.claimed?.address ?? null, claimedName: sender.claimed?.name ?? null, requiresReview: held,
      })
      .onConflictDoNothing().returning({ id: emailMessages.id });
    if (!msg) {
      // Lost a race with a concurrent delivery of the same message.
      return sameDelivery(await findDup());
    }

    const participants = [
      { role: "from" as const, ...m.from }, ...m.to.map((p) => ({ role: "to" as const, ...p })), ...m.cc.map((p) => ({ role: "cc" as const, ...p })),
      ...m.replyTo.map((p) => ({ role: "reply_to" as const, ...p })),
    ];
    await tx.insert(emailParticipants)
      .values(participants.map((p) => ({ organizationId: orgId, messageId: msg.id, role: p.role, address: p.address, name: p.name })));

    if (inspected.length) {
      await tx.insert(emailAttachments).values(inspected.map(({ a, d }) => ({
        organizationId: orgId, messageId: msg.id, filename: a.filename, declaredType: a.declaredType, sniffedType: d.sniffed, sizeBytes: a.sizeBytes,
        sha256: d.sha256, storageKey: d.storageKey, status: d.status, blockReason: d.reason, isInline: a.isInline,
      })));
    }

    const counterpart = inbound ? (sender.identity ?? null) : (m.to.find((p) => p.address !== m.from.address) ?? null);
    let contactId: string | null = null;
    if (counterpart && !(inbound && isInternal) && !hideRule) {
      contactId = await matchContact(
        tx, orgId, counterpart.address, counterpart.name, office, msg.id, inbound && sender.trust === "relay" ? "relay" : "inbound_message",
      );
      await tx.update(contacts)
        .set({
          lastContactAt: sql`greatest(coalesce(${contacts.lastContactAt}, ${m.sentAt.toISOString()}::timestamptz), ${m.sentAt.toISOString()}::timestamptz)`,
        })
        .where(eq(contacts.id, contactId));
      await tx.update(emailParticipants).set({ contactId })
        .where(and(eq(emailParticipants.messageId, msg.id), eq(emailParticipants.address, counterpart.address)));
    }

    const cluster = inbound && !hideRule
      ? await assignTemplateCluster(tx, orgId, msg.id, pre.substantive, m.sentAt, formLetterSettings ?? { overlap: 0.7, minWords: 25 })
      : { clusterId: null, note: null };

    const duplicateOfId = inbound
      ? await settleDuplicate(tx, orgId, {
        id: msg.id, fromAddress: m.from.address, sentAt: m.sentAt, substantive: pre.substantive, trust: sender.trust,
        claimedAddress: sender.claimed?.address ?? null,
      })
      : null;

    await tx.update(emailMessages).set({ contactId, templateClusterId: cluster.clusterId, personalNote: cluster.note, duplicateOfId })
      .where(eq(emailMessages.id, msg.id));
    await tx.update(emailThreads)
      .set({
        messageCount: sql`${emailThreads.messageCount} + 1`,
        lastMessageAt: sql`greatest(coalesce(${emailThreads.lastMessageAt}, ${m.sentAt.toISOString()}::timestamptz), ${m.sentAt.toISOString()}::timestamptz)`,
        firstMessageAt: sql`least(coalesce(${emailThreads.firstMessageAt}, ${m.sentAt.toISOString()}::timestamptz), ${m.sentAt.toISOString()}::timestamptz)`,
      })
      .where(eq(emailThreads.id, threadId));

    if (!inbound) {
      await recordReply(tx, orgId, connectionId, {
        id: msg.id, sentAt: m.sentAt, rfcMessageId: m.rfcMessageId, inReplyTo: m.inReplyTo, references: m.references, subject: m.subject,
        to: [...m.to, ...m.cc].map((p) => p.address), threadId: m.providerThreadId,
      });
    }

    if (held) {
      await tx.insert(reviewQueue)
        .values({
          organizationId: orgId, kind: "sender_check", messageId: msg.id, entityType: "email_message", entityId: msg.id,
          reason: sender.detail.reasons[0] ?? "Sender not confirmed.", priority: sender.trust === "failed" ? 85 : 60,
        })
        .onConflictDoNothing();
    }

    const disposition: LedgerDisposition = hideRule ? "hidden" : held ? "held" : "filed";
    const reason = hideRule ? `Set aside by a sender rule (${hideRule.value}).` : held ? sender.detail.reasons[0] : null;
    await settle(tx, orgId, connectionId, m, { disposition, reason: reason ?? null, messageId: msg.id, ruleId: hideRule?.id });
    if (hideRule) await tx.update(senderRules).set({ hits: sql`${senderRules.hits} + 1` }).where(eq(senderRules.id, hideRule.id));

    if (!hideRule) await enqueue("message.classify", { messageId: msg.id }, { orgId, idempotencyKey: `classify:${msg.id}:${PIPELINE_VERSION}` }, tx);
    return { messageId: msg.id, duplicate: false, contactId, disposition };
  });
}
