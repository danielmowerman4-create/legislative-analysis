"use server";

import { actAndRevalidate } from "../_lib/action";
import { addOfficeEvent, deleteOfficeEvent, updateOfficeEvent, type OfficeEventInput } from "@/server/services/calendar";

export async function addEventAction(input: OfficeEventInput) {
  return actAndRevalidate("/calendar", async (ctx) => {
    await addOfficeEvent(ctx, input);
  });
}

export async function updateEventAction(id: string, input: OfficeEventInput) {
  return actAndRevalidate("/calendar", (ctx) => updateOfficeEvent(ctx, id, input));
}

export async function deleteEventAction(id: string) {
  return actAndRevalidate("/calendar", (ctx) => deleteOfficeEvent(ctx, id));
}
