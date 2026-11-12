import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import { bills, emailDrafts, organizations, trackedBills, users } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError } from "../errors";
import { audit } from "./audit";
import { CONFIRMED, PERSON, THEIR_WORD } from "./center";
import { billFactLines } from "./replies";

const ANSWER_SIDES = ["support", "oppose", "other"] as const;
type AnswerSide = (typeof ANSWER_SIDES)[number];
const SIDE_LABEL: Record<AnswerSide, string> = { support: "Support", oppose: "Oppose", other: "Other" };
const sideOf = (position: string): AnswerSide => (position === "support" || position === "oppose" ? position : "other");
const answerKey = (reference: string, side: AnswerSide) => `${reference}|${side}`;

type Writer = {
  reference: string; billId: string | null; messageId: string; person: string; name: string; address: string | null; side: AnswerSide; receivedAt: Date;
  answered: boolean;
};

// Sensitive mail is left out: it is answered one person at a time.
async function writers(tx: Db, ctx: OfficeContext, reference?: string): Promise<Writer[]> {
  const rows = await tx.execute<{
    reference: string; bill_id: string | null; message_id: string; person: string; name: string | null; address: string | null; from_address: string;
    position: string; received_at: Date | string; answered: boolean;
  }>(sql`
    select distinct on (p.bill_reference, ${PERSON}) p.bill_reference as reference, p.bill_id, m.id as message_id, ${PERSON} as person,
      coalesce(c.full_name, m.claimed_name, m.from_name) as name,
      case when m.sender_trust = 'relay' then m.claimed_address else m.from_address end as address, m.from_address,
      p.position, m.received_at,
      exists (select 1 from message_events e where e.message_id = m.id and e.type = 'reply_sent') as answered
    from issue_positions p
    join email_messages m on m.id = p.message_id
    left join contacts c on c.id = m.contact_id
    where p.organization_id = ${ctx.orgId} and p.target_type = 'bill' and p.status <> 'rejected'
      ${reference ? sql`and p.bill_reference = ${reference}` : sql``}
      and m.direction = 'inbound' and ${CONFIRMED} and m.duplicate_of_id is null and m.is_sensitive = false
    order by p.bill_reference, ${PERSON}, ${THEIR_WORD}`);
  return rows.rows.map((r) => ({
    reference: r.reference, billId: r.bill_id, messageId: r.message_id, person: r.person, name: r.name ?? r.address ?? r.from_address,
    address: r.address?.toLowerCase() ?? null, side: sideOf(r.position), receivedAt: new Date(r.received_at), answered: r.answered,
  }));
}

const openDraft = (reference: string, side: AnswerSide) => and(
  inArray(emailDrafts.status, ["draft", "approved"]),
  sql`${emailDrafts.citations} @> ${JSON.stringify([{ type: "bill_answer", id: answerKey(reference, side) }])}::jsonb`,
);

async function billRecord(tx: Db, ctx: OfficeContext, billId: string | null) {
  if (!billId) return { bill: null, position: null };
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId));
  const [tracked] = await tx.select({ position: trackedBills.position }).from(trackedBills)
    .where(and(eq(trackedBills.organizationId, ctx.orgId), eq(trackedBills.billId, billId)));
  return { bill: bill ?? null, position: tracked && tracked.position !== "watching" ? tracked.position : null };
}

export async function billAnswers(ctx: OfficeContext, reference: string) {
  requirePermission(ctx, "communications.draft");
  return withTenant(tenantScope(ctx), async (tx) => {
    const list = await writers(tx, ctx, reference);
    const billId = list.find((w) => w.billId)?.billId ?? null;
    const { bill, position } = await billRecord(tx, ctx, billId);
    const groups = [];
    for (const side of ANSWER_SIDES) {
      const people = list.filter((w) => w.side === side).sort((a, b) => a.name.localeCompare(b.name));
      if (!people.length) continue;
      const [draft] = await tx.select({
        id: emailDrafts.id, bodyText: emailDrafts.bodyText, status: emailDrafts.status, toAddresses: emailDrafts.toAddresses,
        updatedAt: emailDrafts.updatedAt, author: users.name,
      }).from(emailDrafts).leftJoin(users, eq(users.id, emailDrafts.authorId))
        .where(and(eq(emailDrafts.organizationId, ctx.orgId), openDraft(reference, side)));
      groups.push({
        side, people: people.map((w) => ({ name: w.name, messageId: w.messageId, answered: w.answered, hasAddress: Boolean(w.address) })),
        answered: people.filter((w) => w.answered).length, toAnswer: people.filter((w) => !w.answered && w.address).length,
        noAddress: people.filter((w) => !w.answered && !w.address).length, draft: draft ?? null,
      });
    }
    return {
      reference, billId, title: bill?.title ?? null, status: bill?.status ?? null, lastActionAt: bill?.lastActionAt ?? null,
      lastActionText: bill?.lastActionText ?? null, position, groups,
    };
  });
}

export async function draftBillAnswer(ctx: OfficeContext, reference: string, side: AnswerSide) {
  requirePermission(ctx, "communications.draft");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [existing] = await tx.select().from(emailDrafts).where(and(eq(emailDrafts.organizationId, ctx.orgId), openDraft(reference, side)));
    if (existing) return existing;
    const list = await writers(tx, ctx, reference);
    const waiting = list.filter((w) => w.side === side && !w.answered && w.address);
    if (!waiting.length) throw new AppError("validation", "Everyone on this side has been answered.");
    const billId = list.find((w) => w.billId)?.billId ?? null;
    const { bill, position } = await billRecord(tx, ctx, billId);
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const who = org.legislatorName ?? "Our office";
    const about = bill ? `${bill.identifier} (${bill.title})` : reference;
    const body = [
      `Thank you for contacting ${org.legislatorName ?? "our office"} about ${about}.`, ...(bill ? ["", ...billFactLines(bill, position, who)] : []), "",
      "[Office response]", "", "Sincerely,", org.legislatorName ?? org.name,
    ].join("\n");
    const [d] = await tx.insert(emailDrafts)
      .values({
        organizationId: ctx.orgId, authorId: ctx.userId, toAddresses: [...new Set(waiting.map((w) => w.address!))].sort(),
        subject: bill ? `${bill.identifier}: ${bill.title}` : reference, bodyText: body,
        citations: [
          { type: "bill_answer", id: answerKey(reference, side), label: `${reference}, ${SIDE_LABEL[side].toLowerCase()}` },
          ...(bill ? [{ type: "bill", id: bill.id, label: bill.identifier }] : []),
          ...waiting.map((w) => ({ type: "message", id: w.messageId, label: w.name })),
        ],
      })
      .returning();
    await audit(tx, ctx, "reply.drafted", "email_draft", d.id, { bill: reference, side, people: waiting.length });
    return d;
  });
}

export async function billsToAnswer(ctx: OfficeContext) {
  requirePermission(ctx, "communications.draft");
  return withTenant(tenantScope(ctx), async (tx) => {
    const waiting = (await writers(tx, ctx)).filter((w) => !w.answered && w.address);
    const byBill = new Map<string, Writer[]>();
    for (const w of waiting) byBill.set(w.reference, [...(byBill.get(w.reference) ?? []), w]);
    const ids = [...new Set(waiting.map((w) => w.billId).filter((x): x is string => Boolean(x)))];
    const records = ids.length ? await tx.select().from(bills).where(inArray(bills.id, ids)) : [];
    const tracked = ids.length
      ? await tx.select({ billId: trackedBills.billId, position: trackedBills.position }).from(trackedBills)
        .where(and(eq(trackedBills.organizationId, ctx.orgId), inArray(trackedBills.billId, ids)))
      : [];
    return [...byBill.entries()].map(([reference, people]) => {
      const bill = records.find((b) => b.id === people.find((w) => w.billId)?.billId) ?? null;
      const recorded = tracked.find((t) => t.billId === bill?.id)?.position;
      const position = recorded && recorded !== "watching" ? recorded : null;
      const firstWrote = Math.min(...people.map((w) => w.receivedAt.getTime()));
      const moved = Boolean(bill?.lastActionAt && new Date(`${bill.lastActionAt}T23:59:59Z`).getTime() >= firstWrote);
      const count = (side: AnswerSide) => people.filter((w) => w.side === side).length;
      return {
        reference, billId: bill?.id ?? null, title: bill?.title ?? null, lastActionAt: bill?.lastActionAt ?? null, lastActionText: bill?.lastActionText ?? null,
        moved, position, toAnswer: people.length, support: count("support"), oppose: count("oppose"), other: count("other"),
      };
    }).filter((b) =>
      b.moved || b.position).sort((a, b) => Number(b.moved) - Number(a.moved) || (b.lastActionAt ?? "").localeCompare(a.lastActionAt ?? "") ||
      b.toAnswer - a.toAnswer || a.reference.localeCompare(b.reference));
  });
}
