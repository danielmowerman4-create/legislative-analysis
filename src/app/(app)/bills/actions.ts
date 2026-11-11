"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { act, actAndRevalidate } from "../_lib/action";
import {
  addBillNote,
  linkBills,
  searchBillsByText,
  setBillPosition,
  setFollow,
  trackBills,
  unlinkBills,
  untrackBill,
  updateTracking,
  type TrackingPatch,
  type TrackInput,
} from "@/server/services/legislation";
import { enqueue } from "@/server/jobs/queue";
import { requirePermission, type OfficeContext } from "@/server/authz/context";
import { withTenant } from "@/server/db/client";
import { organizations, type BillPosition } from "@/server/db/schema";

async function actAndRefresh<T>(billIds: string[], fn: (ctx: OfficeContext) => Promise<T>) {
  const r = await act(fn);
  revalidatePath("/bills");
  revalidatePath("/tracked");
  revalidatePath("/today");
  for (const id of billIds) revalidatePath(`/bills/${id}`);
  return r;
}

export async function trackBillsAction(billIds: string[], input: TrackInput) {
  return actAndRefresh(billIds, (ctx) => trackBills(ctx, billIds, input));
}

export async function setPositionAction(billId: string, position: BillPosition) {
  const r = await act((ctx) => setBillPosition(ctx, billId, position));
  revalidatePath("/", "layout");
  return r;
}

export async function untrackAction(billId: string) {
  return actAndRefresh([billId], (ctx) => untrackBill(ctx, billId));
}

export async function updateTrackingAction(billId: string, patch: TrackingPatch) {
  return actAndRefresh([billId], (ctx) => updateTracking(ctx, billId, patch));
}

export async function followAction(billId: string, on: boolean) {
  return actAndRevalidate(`/bills/${billId}`, (ctx) => setFollow(ctx, "bill", billId, on));
}

export async function billNoteAction(billId: string, body: string) {
  return actAndRevalidate(`/bills/${billId}`, (ctx) => addBillNote(ctx, billId, body));
}

export async function linkBillAction(billId: string, otherId: string, note: string) {
  return actAndRefresh([billId, otherId], (ctx) => linkBills(ctx, billId, otherId, note));
}

export async function unlinkBillAction(billId: string, otherId: string) {
  return actAndRefresh([billId, otherId], (ctx) => unlinkBills(ctx, billId, otherId));
}

export async function findBillsAction(q: string) {
  if (q.trim().length < 2) return { ok: true as const, data: [] };
  return act((ctx) => searchBillsByText(ctx, q.trim(), 8));
}

export async function syncNowAction() {
  return act(async (ctx) => {
    requirePermission(ctx, "integrations.manage");
    const [org] = await withTenant({ orgId: ctx.orgId },
      (tx) => tx.select({ j: organizations.jurisdictionCode }).from(organizations).where(eq(organizations.id, ctx.orgId)),
    );
    await enqueue("legislation.sync", { jurisdiction: org.j }, { idempotencyKey: `legsync:${org.j}:manual:${Math.floor(Date.now() / 300_000)}` });
  });
}
