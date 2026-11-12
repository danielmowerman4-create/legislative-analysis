"use server";

import { revalidatePath } from "next/cache";
import { act } from "../_lib/action";
import { approvePress, createPress, deletePress, savePressGraphic, updatePress, type PressInput } from "@/server/services/press";
import type { PressGraphic } from "@/server/db/schema";

async function press<T>(fn: Parameters<typeof act<T>>[0]) {
  const r = await act(fn);
  revalidatePath("/press", "layout");
  return r;
}

export async function createPressAction(input: PressInput) {
  return press((ctx) => createPress(ctx, input));
}

export async function savePressAction(id: string, patch: { headline: string; body: string }) {
  return press((ctx) => updatePress(ctx, id, patch));
}

export async function approvePressAction(id: string) {
  return press((ctx) => approvePress(ctx, id));
}

export async function deletePressAction(id: string) {
  return press((ctx) => deletePress(ctx, id));
}

export async function saveGraphicAction(id: string, graphic: PressGraphic) {
  return press((ctx) => savePressGraphic(ctx, id, graphic));
}
