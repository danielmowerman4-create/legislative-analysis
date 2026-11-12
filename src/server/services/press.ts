import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "../db/client";
import { bills, officeSettings, organizations, pressItems, trackedBills, users, type PressGraphic, type PressKind } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, notFound } from "../errors";
import { getAiProvider } from "../ai/provider";
import { maskForModel } from "../classification/preprocess";
import { audit } from "./audit";

export const PRESS_KIND_LABEL: Record<PressKind, string> = {
  statement: "Statement", vote: "On a vote", bill: "On a bill", hearing: "On a hearing", event: "On an event",
};
export const OWN_WORDS = "[The legislator's own words]";
const CONTACT = "[Name, phone and email for the press]";

const HEADLINE: Record<PressKind, (who: string, about: string) => string> = {
  statement: (who, about) => `${who} on ${about}`,
  vote: (who, about) => `${who} on the vote on ${about}`,
  bill: (who, about) => `${who} on ${about}`,
  hearing: (who, about) => `${who} on the hearing on ${about}`,
  event: (who, about) => `${who} on ${about}`,
};

const longDate = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const POSITION_VERB: Record<string, string> = { support: "supports", oppose: "opposes", neutral: "has not taken a side on" };
const STANDS: Record<string, string> = {
  introduced: "has been introduced", in_committee: "is in committee", passed_chamber: "has passed one chamber", passed_both: "has passed both chambers",
  sent_to_executive: "is on the governor's desk", enacted: "is now law", vetoed: "was vetoed", failed: "did not pass", withdrawn: "was withdrawn",
  other: "is before the legislature",
};
const dayWritten = (iso: string) => longDate.format(new Date(`${iso}T12:00:00Z`));

export type PressInput = { kind: PressKind; billId?: string | null; about?: string | null; words?: string | null };

// The record is written in by code. AI may only shape the office's own notes into the quote.
export async function createPress(ctx: OfficeContext, input: PressInput) {
  requirePermission(ctx, "communications.draft");
  const data = await withTenant(tenantScope(ctx), async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));
    const [bill] = input.billId ? await tx.select().from(bills).where(eq(bills.id, input.billId)) : [];
    if (input.billId && (!bill || bill.jurisdictionCode !== org.jurisdictionCode)) throw notFound("Bill not found.");
    const [tracked] = bill
      ? await tx.select({ position: trackedBills.position }).from(trackedBills)
        .where(and(eq(trackedBills.organizationId, ctx.orgId), eq(trackedBills.billId, bill.id)))
      : [];
    const [settings] = await tx.select({ ai: officeSettings.aiEnabled, consent: officeSettings.aiConsentAt }).from(officeSettings)
      .where(eq(officeSettings.organizationId, ctx.orgId));
    return { org, bill: bill ?? null, position: tracked?.position ?? null, ai: Boolean(settings?.ai && settings.consent) };
  });
  const { org, bill, position } = data;
  const who = org.legislatorName ?? org.name;
  const about = bill ? `${bill.identifier}, ${bill.title}` : input.about?.trim();
  if (!about) throw new AppError("validation", "Choose a bill or say what the statement is about.");
  const notes = input.words?.trim().slice(0, 4000) ?? "";

  const record = bill
    ? [`${bill.identifier}, ${bill.title}, ${STANDS[bill.status]}.${bill.lastActionText
      ? ` Its most recent action${bill.lastActionAt ? `, on ${dayWritten(bill.lastActionAt)}` : ""}: ${bill.lastActionText.replace(/\.$/, "")}.` : ""}`,
    ...(position && POSITION_VERB[position] ? [`${who} ${POSITION_VERB[position]} ${bill.identifier}.`] : [])]
    : [];

  let quote = notes || OWN_WORDS;
  let aiGenerated = false;
  const provider = notes ? await getAiProvider(data.ai) : null;
  if (provider) {
    const r = await provider.generate({
      system: "You help a state legislator's office write a press statement. Turn the office's notes into two to four sentences in the legislator's own voice, first person, plain words. Use only what the notes and the record say. Do not add facts, numbers, dates, names, promises or quotes from anyone else. Do not use quotation marks.",
      sources: [
        { id: "notes", label: "The office's notes", text: maskForModel(notes) },
        ...(record.length ? [{ id: "record", label: "The bill's record", text: record.join("\n") }] : []),
      ],
      task: "Write the statement. Cite the notes inline as [source:notes]; the marks are removed before staff see the draft.",
      maxTokens: 900,
    });
    const text = r?.text.replace(/\s*\[source:[^\]]+\]/g, "").replace(/["“”]/g, "").trim();
    if (text) {
      quote = text;
      aiGenerated = true;
    }
  }

  const headline = HEADLINE[input.kind](who, bill ? bill.identifier : about).slice(0, 200);
  const body = [
    "FOR IMMEDIATE RELEASE", longDate.format(new Date()), "", `${who} released this statement on ${about}:`, "", `"${quote}"`,
    ...(record.length ? ["", ...record] : []), "", `Contact: ${CONTACT}`,
  ].join("\n");

  return withTenant(tenantScope(ctx), async (tx) => {
    const [p] = await tx.insert(pressItems)
      .values({ organizationId: ctx.orgId, kind: input.kind, headline, body, billId: bill?.id ?? null, aiGenerated, authorId: ctx.userId })
      .returning({ id: pressItems.id });
    await audit(tx, ctx, "press.drafted", "press_item", p.id, { kind: input.kind, bill: bill?.identifier ?? null, aiGenerated });
    return p.id;
  });
}

export async function listPress(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      id: pressItems.id, kind: pressItems.kind, headline: pressItems.headline, status: pressItems.status, updatedAt: pressItems.updatedAt,
      bill: bills.identifier, author: users.name,
    }).from(pressItems).leftJoin(bills, eq(bills.id, pressItems.billId)).leftJoin(users, eq(users.id, pressItems.authorId))
      .where(eq(pressItems.organizationId, ctx.orgId)).orderBy(desc(pressItems.updatedAt)).limit(200));
}

export async function getPress(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), async (tx) => {
    const [p] = await tx.select().from(pressItems).where(and(eq(pressItems.id, id), eq(pressItems.organizationId, ctx.orgId)));
    if (!p) throw notFound("Statement not found.");
    const [org] = await tx.select({
      legislatorName: organizations.legislatorName, name: organizations.name, chamber: organizations.chamber, district: organizations.district,
    }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const [bill] = p.billId
      ? await tx.select({ id: bills.id, identifier: bills.identifier, title: bills.title }).from(bills).where(eq(bills.id, p.billId))
      : [];
    const [approver] = p.approvedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, p.approvedBy)) : [];
    return { ...p, bill: bill ?? null, approvedByName: approver?.name ?? null, office: org };
  });
}

// Any change clears an approval: what was approved is exactly what goes out.
export async function updatePress(ctx: OfficeContext, id: string, patch: { headline: string; body: string }) {
  requirePermission(ctx, "communications.draft");
  const headline = patch.headline.trim().slice(0, 200);
  if (!headline) throw new AppError("validation", "Give it a headline.");
  await withTenant(tenantScope(ctx), async (tx) => {
    const done = await tx.update(pressItems)
      .set({ headline, body: patch.body.slice(0, 20_000), status: "draft", approvedBy: null, approvedAt: null, updatedAt: new Date() })
      .where(and(eq(pressItems.id, id), eq(pressItems.organizationId, ctx.orgId))).returning({ id: pressItems.id });
    if (!done.length) throw notFound("Statement not found.");
  });
}

const HEX = /^#[0-9a-f]{6}$/i;

export async function savePressGraphic(ctx: OfficeContext, id: string, g: PressGraphic) {
  requirePermission(ctx, "communications.draft");
  if (!HEX.test(g.field) || !HEX.test(g.accent)) throw new AppError("validation", "Choose both colors.");
  const graphic: PressGraphic = {
    layout: g.layout, size: g.size, headline: g.headline.slice(0, 160), statement: g.statement.slice(0, 400), kicker: g.kicker.slice(0, 120),
    field: g.field, accent: g.accent,
  };
  await withTenant(tenantScope(ctx), (tx) =>
    tx.update(pressItems).set({ graphic }).where(and(eq(pressItems.id, id), eq(pressItems.organizationId, ctx.orgId))));
}

export async function approvePress(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "communications.approve");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [p] = await tx.select({ body: pressItems.body }).from(pressItems).where(and(eq(pressItems.id, id), eq(pressItems.organizationId, ctx.orgId)));
    if (!p) throw notFound("Statement not found.");
    if (/\[[^\]]+\]/.test(p.body)) throw new AppError("validation", "Replace every part in [brackets] before approving.");
    await tx.update(pressItems).set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date() }).where(eq(pressItems.id, id));
    await audit(tx, ctx, "press.approved", "press_item", id);
  });
}

export async function deletePress(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "communications.draft");
  await withTenant(tenantScope(ctx), async (tx) => {
    const gone = await tx.delete(pressItems).where(and(eq(pressItems.id, id), eq(pressItems.organizationId, ctx.orgId))).returning({ id: pressItems.id });
    if (gone.length) await audit(tx, ctx, "press.removed", "press_item", id);
  });
}

// Tracked bills first: they are what the office is most likely to speak on.
export async function pressBillOptions(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({ id: bills.id, identifier: bills.identifier, title: bills.title }).from(trackedBills).innerJoin(bills, eq(bills.id, trackedBills.billId))
      .where(eq(trackedBills.organizationId, ctx.orgId)).orderBy(bills.billType, bills.number).limit(300));
}
