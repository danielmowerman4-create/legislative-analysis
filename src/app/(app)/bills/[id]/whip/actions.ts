"use server";

import { act } from "../../../_lib/action";
import { setWhipStance } from "@/server/services/tools";
import type { WhipStance } from "@/lib/whip";

export async function setWhipStanceAction(billId: string, legislatorId: string, stance: WhipStance | null, note?: string | null) {
  return act((ctx) => setWhipStance(ctx, billId, legislatorId, stance, note));
}
