"use server";

import { actAndRevalidate } from "../_lib/action";
import { addAlertRule, deleteAlertRule, setAlertRuleActive } from "@/server/services/tools";
import type { BillAlertKind } from "@/server/db/schema";

export async function addAlertRuleAction(kind: BillAlertKind, value: string) {
  return actAndRevalidate("/alerts", (ctx) => addAlertRule(ctx, kind, value));
}

export async function setAlertRuleActiveAction(id: string, active: boolean) {
  return actAndRevalidate("/alerts", (ctx) => setAlertRuleActive(ctx, id, active));
}

export async function deleteAlertRuleAction(id: string) {
  return actAndRevalidate("/alerts", (ctx) => deleteAlertRule(ctx, id));
}
