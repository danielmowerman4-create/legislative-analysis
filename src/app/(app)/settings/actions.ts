"use server";

import { act, actAndRevalidate } from "../_lib/action";
import { updateOfficeProfile, updateSettings } from "@/server/services/settings";
import { requestMeta, setSessionCookie } from "@/server/auth/next";
import { changePassword, createSession, revokeAllSessions } from "@/server/auth/sessions";
import { AppError } from "@/server/errors";

export async function profileAction(input: { name: string; legislatorName: string; district: string }) {
  return actAndRevalidate("/settings",
    (ctx) => updateOfficeProfile(ctx, { name: input.name.trim(), legislatorName: input.legislatorName.trim(), district: input.district.trim() }),
  );
}

export async function changePasswordAction(input: { current: string; next: string; confirm: string }) {
  return act(async (ctx) => {
    if (input.next !== input.confirm) throw new AppError("validation", "The two new passwords do not match.");
    const meta = await requestMeta();
    await changePassword(ctx.userId, input.current, input.next, meta);
    // End every other sign-in; this browser carries on with a new token.
    await revokeAllSessions(ctx.userId);
    await setSessionCookie(await createSession(ctx.userId, { orgId: ctx.orgId, mfaVerified: true, ...meta }));
  });
}

export async function mfaPolicyAction(requireMfa: boolean) {
  return actAndRevalidate("/settings", (ctx) => updateSettings(ctx, { requireMfa }));
}
