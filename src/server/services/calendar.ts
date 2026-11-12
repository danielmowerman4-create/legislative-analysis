import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { withTenant, type Db } from "../db/client";
import { committees, follows, officeEvents, users } from "../db/schema";
import { requirePermission, tenantScope, type OfficeContext } from "../authz/context";
import { AppError, notFound } from "../errors";
import { localTimeToIso } from "../legislation/normalize";
import { DISPLAY_TIME_ZONE } from "@/lib/format";
import { audit } from "./audit";
import { listEvents, officeLegislator, officeOf } from "./legislation";

export const CALENDAR_SCOPES = { mine: "My committees and tracked bills", all: "All hearings", tracked: "Tracked bills only" } as const;
export type CalendarScope = keyof typeof CALENDAR_SCOPES;

// Committees the office's legislator sits on, plus any this person follows.
async function officeCommitteeIds(tx: Db, ctx: OfficeContext) {
  const org = await officeOf(tx, ctx);
  const codes = (await officeLegislator(tx, org))?.committeeRoles.flatMap((r) => r.code ?? []) ?? [];
  const seated = codes.length
    ? await tx.select({ id: committees.id }).from(committees)
      .where(and(eq(committees.jurisdictionCode, org.jurisdiction), inArray(committees.providerCommitteeId, codes)))
    : [];
  const followed = await tx.select({ key: follows.targetKey }).from(follows)
    .where(and(eq(follows.organizationId, ctx.orgId), eq(follows.userId, ctx.userId), eq(follows.targetType, "committee")));
  return new Set([...seated.map((c) => c.id), ...followed.map((f) => f.key)]);
}

export async function officeCalendar(ctx: OfficeContext, opts: { from: Date; to: Date; scope: CalendarScope }) {
  requirePermission(ctx, "legislation.read");
  const hearings = await listEvents(ctx, { from: opts.from, to: opts.to, trackedOnly: opts.scope === "tracked" });
  const { own, seats } = await withTenant(tenantScope(ctx), async (tx) => ({
    own: await tx.select({
      id: officeEvents.id, title: officeEvents.title, startsAt: officeEvents.startsAt, allDay: officeEvents.allDay, location: officeEvents.location,
      note: officeEvents.note, addedBy: users.name,
    }).from(officeEvents).leftJoin(users, eq(users.id, officeEvents.createdBy))
      .where(and(eq(officeEvents.organizationId, ctx.orgId), gte(officeEvents.startsAt, opts.from), lte(officeEvents.startsAt, opts.to)))
      .orderBy(asc(officeEvents.startsAt)),
    seats: await officeCommitteeIds(tx, ctx),
  }));
  const mine = (e: (typeof hearings)[number]) => Boolean(e.committeeId && seats.has(e.committeeId)) || e.bills.some((b) => b.position);
  return { hearings: opts.scope === "mine" ? hearings.filter(mine) : hearings, own, hasSeats: seats.size > 0 };
}

export async function hasUpcomingOwn(ctx: OfficeContext) {
  requirePermission(ctx, "legislation.read");
  const rows = await withTenant(tenantScope(ctx), (tx) =>
    tx.select({ id: officeEvents.id }).from(officeEvents)
      .where(and(eq(officeEvents.organizationId, ctx.orgId), gte(officeEvents.startsAt, new Date(Date.now() - 86400_000)))).limit(1));
  return rows.length > 0;
}

export type OfficeEventInput = { title: string; date: string; time?: string | null; location?: string | null; note?: string | null };

function eventValues(input: OfficeEventInput) {
  const title = input.title.trim();
  if (!title) throw new AppError("validation", "Give it a name.");
  const time = input.time?.trim() || null;
  if (time && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError("validation", "Write the time like 9:30 or 14:00.");
  const startsAt = localTimeToIso(input.date, time ?? "00:00", DISPLAY_TIME_ZONE);
  if (!startsAt) throw new AppError("validation", "Choose a date.");
  return {
    title: title.slice(0, 200), startsAt: new Date(startsAt), allDay: !time, location: input.location?.trim().slice(0, 200) || null,
    note: input.note?.trim().slice(0, 2000) || null,
  };
}

export async function addOfficeEvent(ctx: OfficeContext, input: OfficeEventInput) {
  requirePermission(ctx, "legislation.track");
  const values = eventValues(input);
  return withTenant(tenantScope(ctx), async (tx) => {
    const [e] = await tx.insert(officeEvents).values({ ...values, organizationId: ctx.orgId, createdBy: ctx.userId }).returning({ id: officeEvents.id });
    await audit(tx, ctx, "calendar.added", "office_event", e.id, { title: values.title });
    return e.id;
  });
}

export async function updateOfficeEvent(ctx: OfficeContext, id: string, input: OfficeEventInput) {
  requirePermission(ctx, "legislation.track");
  const values = eventValues(input);
  await withTenant(tenantScope(ctx), async (tx) => {
    const done = await tx.update(officeEvents).set({ ...values, updatedAt: new Date() })
      .where(and(eq(officeEvents.id, id), eq(officeEvents.organizationId, ctx.orgId))).returning({ id: officeEvents.id });
    if (!done.length) throw notFound("That calendar entry is gone.");
    await audit(tx, ctx, "calendar.changed", "office_event", id, { title: values.title });
  });
}

export async function deleteOfficeEvent(ctx: OfficeContext, id: string) {
  requirePermission(ctx, "legislation.track");
  await withTenant(tenantScope(ctx), async (tx) => {
    const gone = await tx.delete(officeEvents).where(and(eq(officeEvents.id, id), eq(officeEvents.organizationId, ctx.orgId)))
      .returning({ title: officeEvents.title });
    if (gone.length) await audit(tx, ctx, "calendar.removed", "office_event", id, { title: gone[0].title });
  });
}
