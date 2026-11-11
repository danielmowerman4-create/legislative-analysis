import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { withTenant } from "../db/client";
import { contacts, emailMessages, emailParticipants, reviewQueue, senderRules } from "../db/schema";
import { preprocess } from "../classification/preprocess";
import { assessSender, matchesSenderRule } from "../email/sender-trust";
import { enqueue } from "../jobs/queue";
import { matchContact, officeDomains, settleDuplicate } from "./ingest";

const PAGE = 100;

export async function reattributeSender(orgId: string, ruleId: string, runKey: string) {
  const setup = await withTenant({ orgId }, async (tx) => {
    const [rule] = await tx.select({ kind: senderRules.kind, matchType: senderRules.matchType, value: senderRules.value }).from(senderRules)
      .where(and(eq(senderRules.id, ruleId), eq(senderRules.organizationId, orgId)));
    if (!rule || rule.kind !== "relay") return null;
    const office = await officeDomains(tx, orgId);
    const active = await tx.select().from(senderRules).where(and(eq(senderRules.organizationId, orgId), eq(senderRules.status, "active")));
    return { rule, office, relayRules: active.filter((r) => r.kind === "relay"), hideRules: active.filter((r) => r.kind === "hide") };
  });
  if (!setup) return { changed: 0 };
  const { rule, office, relayRules, hideRules } = setup;
  const fromSender = rule.matchType === "address" ? eq(emailMessages.fromAddress, rule.value)
    : sql`(${emailMessages.fromAddress} like ${`%@${rule.value}`} or ${emailMessages.fromAddress} like ${`%.${rule.value}`})`;

  let changed = 0;
  let after: string | null = null;
  for (;;) {
    const page: string[] = await withTenant({ orgId }, async (tx) => {
      const rows = await tx.select().from(emailMessages)
        .where(and(
          eq(emailMessages.organizationId, orgId), eq(emailMessages.direction, "inbound"), inArray(emailMessages.senderTrust, ["verified", "relay"]),
          fromSender, after ? gt(emailMessages.id, after) : undefined,
        ))
        .orderBy(asc(emailMessages.id)).limit(PAGE);
      for (const msg of rows) {
        if (!matchesSenderRule(msg.fromAddress, rule)) continue;
        const replyTo = await tx.select({ address: emailParticipants.address, name: emailParticipants.name }).from(emailParticipants)
          .where(and(eq(emailParticipants.messageId, msg.id), eq(emailParticipants.role, "reply_to")));
        const pre = preprocess({ bodyText: msg.bodyText, bodyHtml: msg.bodyHtmlSanitized });
        const sender = assessSender({
          from: { address: msg.fromAddress, name: msg.fromName }, replyTo, headers: msg.headers, relayRules, internalDomains: office.internalDomains,
          body: [pre.substantive, pre.signature].filter(Boolean).join("\n"),
        });
        // A person vouched for this sender; their decision stands.
        if (sender.trust !== "verified" && sender.trust !== "relay") continue;
        const claimed = sender.claimed?.address ?? null;
        if (sender.trust === msg.senderTrust && claimed === msg.claimedAddress) continue;

        await tx.delete(reviewQueue).where(and(eq(reviewQueue.messageId, msg.id), eq(reviewQueue.kind, "contact_match"), eq(reviewQueue.status, "open")));
        let contactId: string | null = null;
        const hidden = hideRules.some((r) => matchesSenderRule(msg.fromAddress, r));
        if (sender.identity && !sender.isInternal && !hidden) {
          contactId = await matchContact(
            tx, orgId, sender.identity.address, sender.identity.name, office, msg.id, sender.trust === "relay" ? "relay" : "inbound_message",
          );
          await tx.update(contacts)
            .set({
              lastContactAt: sql`greatest(coalesce(${contacts.lastContactAt}, ${msg.sentAt.toISOString()}::timestamptz), ${msg.sentAt.toISOString()}::timestamptz)`,
            })
            .where(eq(contacts.id, contactId));
        }
        await tx.update(emailParticipants).set({ contactId: null }).where(eq(emailParticipants.messageId, msg.id));
        if (contactId && sender.identity) {
          await tx.update(emailParticipants).set({ contactId })
            .where(and(eq(emailParticipants.messageId, msg.id), eq(emailParticipants.address, sender.identity.address)));
        }
        await tx.update(emailMessages)
          .set({
            senderTrust: sender.trust, senderTrustDetail: sender.detail, claimedAddress: claimed, claimedName: sender.claimed?.name ?? null,
            isInternal: sender.isInternal, contactId,
          })
          .where(eq(emailMessages.id, msg.id));

        const repeats = await tx.select({
          id: emailMessages.id, fromAddress: emailMessages.fromAddress, sentAt: emailMessages.sentAt, substantive: emailMessages.substantiveText,
          trust: emailMessages.senderTrust, claimedAddress: emailMessages.claimedAddress,
        }).from(emailMessages).where(and(eq(emailMessages.organizationId, orgId), eq(emailMessages.duplicateOfId, msg.id)));
        for (const m of [
          { id: msg.id, fromAddress: msg.fromAddress, sentAt: msg.sentAt, substantive: msg.substantiveText, trust: sender.trust, claimedAddress: claimed },
          ...repeats,
        ]) {
          const duplicateOfId = await settleDuplicate(tx, orgId, m);
          await tx.update(emailMessages).set({ duplicateOfId }).where(eq(emailMessages.id, m.id));
        }

        if (msg.processingStatus !== "pending") {
          await enqueue("message.classify", { messageId: msg.id }, { orgId, idempotencyKey: `classify:${msg.id}:sender:${runKey}` }, tx);
        }
        changed++;
      }
      return rows.map((r) => r.id);
    });
    if (page.length < PAGE) break;
    after = page[page.length - 1];
  }
  return { changed };
}
