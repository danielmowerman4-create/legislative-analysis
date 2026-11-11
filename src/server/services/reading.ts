import { and, asc, count, eq, or } from "drizzle-orm";
import { withTenant } from "../db/client";
import { agencyDirectory, issueTaxonomy, officeSettings, type AutoAcceptThresholds } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError } from "../errors";
import { FREEMAIL } from "../classification/rules";
import { audit } from "./audit";
import { enqueue } from "../jobs/queue";

async function readStoredMailAgain(orgId: string) {
  const wait = 30_000;
  await enqueue("mail.reread", { changed: true }, {
    orgId, runAt: new Date(Date.now() + wait), idempotencyKey: `reread:${orgId}:changed:${Math.floor(Date.now() / wait)}`,
  });
}

function cleanKeywords(input: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const word = raw.trim().replace(/\s+/g, " ");
    if (!word) continue;
    if (word.length < 2 || word.length > 80) throw new AppError("validation", `"${word.slice(0, 30)}" must be between 2 and 80 characters.`);
    const parts = word.split("+");
    if (parts.length > 3 || parts.some((p) => !p.trim())) throw new AppError("validation", `"${word.slice(0, 30)}" can join at most three words with +.`);
    if (!seen.has(word.toLowerCase())) {
      seen.add(word.toLowerCase());
      out.push(word);
    }
  }
  if (out.length > 200) throw new AppError("validation", "Keep each issue to 200 words or phrases.");
  return out;
}

const slugOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "issue";

export async function issueListForEditing(ctx: OfficeContext) {
  requirePermission(ctx, "taxonomy.manage");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      key: issueTaxonomy.key, parentKey: issueTaxonomy.parentKey, label: issueTaxonomy.label, keywords: issueTaxonomy.keywords,
      isActive: issueTaxonomy.isActive,
    }).from(issueTaxonomy).where(eq(issueTaxonomy.organizationId, ctx.orgId)).orderBy(asc(issueTaxonomy.sortOrder), asc(issueTaxonomy.label)));
}

export async function saveIssue(ctx: OfficeContext, input: { key?: string; parentKey?: string | null; label: string; keywords: string[] }) {
  requirePermission(ctx, "taxonomy.manage");
  const label = input.label.trim().replace(/\s+/g, " ");
  if (label.length < 2 || label.length > 80) throw new AppError("validation", "Give the issue a name of 2 to 80 characters.");
  const keywords = cleanKeywords(input.keywords);
  const key = await saveIssueRow(ctx, input, label, keywords);
  await readStoredMailAgain(ctx.orgId);
  return key;
}

async function saveIssueRow(ctx: OfficeContext, input: { key?: string; parentKey?: string | null }, label: string, keywords: string[]) {
  return withTenant(tenantScope(ctx), async (tx) => {
    const all = await tx.select({ key: issueTaxonomy.key, parentKey: issueTaxonomy.parentKey, label: issueTaxonomy.label }).from(issueTaxonomy)
      .where(eq(issueTaxonomy.organizationId, ctx.orgId));
    const existing = input.key ? all.find((n) => n.key === input.key) : undefined;
    if (input.key && !existing) throw new AppError("not_found", "That issue is no longer on the list.");
    const parentKey = existing ? existing.parentKey : (input.parentKey ?? null);
    if (parentKey && !all.some((n) => n.key === parentKey && !n.parentKey)) throw new AppError("validation", "That area is no longer on the list.");
    if (all.some((n) => n.key !== input.key && n.parentKey === parentKey && n.label.toLowerCase() === label.toLowerCase())) {
      throw new AppError("validation", `There is already an issue called ${label} here.`);
    }
    if (existing) {
      await tx.update(issueTaxonomy).set({ label, keywords }).where(and(eq(issueTaxonomy.organizationId, ctx.orgId), eq(issueTaxonomy.key, existing.key)));
      await audit(tx, ctx, "taxonomy.issue_changed", "issue_taxonomy", null, { key: existing.key, label, keywords });
      return existing.key;
    }
    const base = parentKey ? `${parentKey}.${slugOf(label)}` : slugOf(label);
    let key = base;
    for (let n = 2; all.some((x) => x.key === key); n++) key = `${base}_${n}`;
    const [{ siblings }] = await tx.select({ siblings: count() }).from(issueTaxonomy).where(eq(issueTaxonomy.organizationId, ctx.orgId));
    await tx.insert(issueTaxonomy).values({ organizationId: ctx.orgId, key, parentKey, label, keywords, sortOrder: siblings, createdBy: ctx.userId });
    await audit(tx, ctx, "taxonomy.issue_added", "issue_taxonomy", null, { key, label, keywords });
    return key;
  });
}

export async function setIssueActive(ctx: OfficeContext, key: string, active: boolean) {
  requirePermission(ctx, "taxonomy.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    const [node] = await tx.select({ key: issueTaxonomy.key, parentKey: issueTaxonomy.parentKey }).from(issueTaxonomy)
      .where(and(eq(issueTaxonomy.organizationId, ctx.orgId), eq(issueTaxonomy.key, key)));
    if (!node) throw new AppError("not_found", "That issue is no longer on the list.");
    const inOffice = eq(issueTaxonomy.organizationId, ctx.orgId);
    await tx.update(issueTaxonomy).set({ isActive: active }).where(and(inOffice, or(eq(issueTaxonomy.key, key), eq(issueTaxonomy.parentKey, key))));
    if (active && node.parentKey) await tx.update(issueTaxonomy).set({ isActive: true }).where(and(inOffice, eq(issueTaxonomy.key, node.parentKey)));
    await audit(tx, ctx, active ? "taxonomy.issue_on" : "taxonomy.issue_off", "issue_taxonomy", null, { key });
  });
}

export async function agenciesForEditing(ctx: OfficeContext) {
  requirePermission(ctx, "settings.manage");
  return withTenant(tenantScope(ctx), (tx) =>
    tx.select({
      id: agencyDirectory.id, name: agencyDirectory.name, abbreviation: agencyDirectory.abbreviation, domains: agencyDirectory.domains,
      isActive: agencyDirectory.isActive,
    }).from(agencyDirectory).where(eq(agencyDirectory.organizationId, ctx.orgId)).orderBy(asc(agencyDirectory.name)));
}

export async function saveAgency(ctx: OfficeContext, input: { id?: string; name: string; abbreviation?: string; domains: string[] }) {
  requirePermission(ctx, "settings.manage");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) throw new AppError("validation", "Give the agency a name of 2 to 120 characters.");
  const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  for (const d of domains) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new AppError("validation", `${d} is not an email domain.`);
    if (FREEMAIL.has(d)) throw new AppError("validation", `${d} is a public mail service, so it cannot identify an agency.`);
  }
  const abbreviation = input.abbreviation?.trim() || null;
  await withTenant(tenantScope(ctx), async (tx) => {
    const others = await tx.select({ id: agencyDirectory.id, name: agencyDirectory.name }).from(agencyDirectory)
      .where(eq(agencyDirectory.organizationId, ctx.orgId));
    if (others.some((a) => a.id !== input.id && a.name.toLowerCase() === name.toLowerCase())) {
      throw new AppError("validation", `${name} is already on the list.`);
    }
    if (input.id) {
      await tx.update(agencyDirectory).set({ name, abbreviation, domains })
        .where(and(eq(agencyDirectory.id, input.id), eq(agencyDirectory.organizationId, ctx.orgId)));
    } else {
      await tx.insert(agencyDirectory).values({ organizationId: ctx.orgId, name, abbreviation, domains });
    }
    await audit(tx, ctx, input.id ? "settings.agency_changed" : "settings.agency_added", "agency_directory", input.id ?? null, { name, abbreviation, domains });
  });
  await readStoredMailAgain(ctx.orgId);
}

export async function setAgencyActive(ctx: OfficeContext, id: string, active: boolean) {
  requirePermission(ctx, "settings.manage");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(agencyDirectory).set({ isActive: active }).where(and(eq(agencyDirectory.id, id), eq(agencyDirectory.organizationId, ctx.orgId)));
    await audit(tx, ctx, active ? "settings.agency_on" : "settings.agency_off", "agency_directory", id);
  });
}

export async function readingSettings(ctx: OfficeContext) {
  requirePermission(ctx, "settings.manage");
  const [s] = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({ thresholds: officeSettings.thresholds, aiDailyLimit: officeSettings.aiDailyLimit }).from(officeSettings)
      .where(eq(officeSettings.organizationId, ctx.orgId)));
  return s;
}

export async function setTaggingLevels(ctx: OfficeContext, levels: AutoAcceptThresholds) {
  requirePermission(ctx, "settings.manage");
  for (const value of Object.values(levels)) {
    if (!(value >= 0.5 && value <= 0.99)) throw new AppError("validation", "Each level must be between 50 and 99 percent.");
  }
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ thresholds: levels, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.tagging_levels", "office_settings", ctx.orgId, levels);
  });
  await readStoredMailAgain(ctx.orgId);
}

export async function setAiDailyLimit(ctx: OfficeContext, limit: number) {
  requirePermission(ctx, "settings.manage");
  if (!Number.isInteger(limit) || limit < 0 || limit > 100_000) throw new AppError("validation", "Enter a whole number from 0 to 100,000.");
  await withTenant(tenantScope(ctx), async (tx) => {
    await tx.update(officeSettings).set({ aiDailyLimit: limit, updatedAt: new Date() }).where(eq(officeSettings.organizationId, ctx.orgId));
    await audit(tx, ctx, "settings.ai_daily_limit", "office_settings", ctx.orgId, { limit });
  });
}
