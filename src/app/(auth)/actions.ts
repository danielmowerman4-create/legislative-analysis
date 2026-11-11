"use server";

import { redirect } from "next/navigation";
import { returnTo } from "@/lib/return-to";
import { z } from "zod";
import {
  changePassword,
  completeMfa,
  createSession,
  loginWithPassword,
  revokeSession,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  revokeAllSessions,
} from "@/server/auth/sessions";
import { clearSessionCookie, getSession, requestMeta, sessionToken, setSessionCookie } from "@/server/auth/next";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/errors";
import { otpauthUrl } from "@/server/auth/totp";
import { cookies } from "next/headers";

export type FormState = { error?: string; ok?: boolean; data?: Record<string, string> };

const loginSchema = z.object({ email: z.email("Enter a valid email address."), password: z.string().min(1, "Enter your password.") });

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  let mfaPending = false;
  try {
    const res = await loginWithPassword(parsed.data.email, parsed.data.password, await requestMeta());
    await setSessionCookie(res.token);
    mfaPending = res.mfaPending;
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  const next = returnTo(form.get("next"));
  redirect(mfaPending ? `/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}` : (next ?? "/today"));
}

export async function mfaAction(_: FormState, form: FormData): Promise<FormState> {
  const token = await sessionToken();
  if (!token) redirect("/login");
  try {
    const next = await completeMfa(token, String(form.get("code") ?? ""), await requestMeta());
    await setSessionCookie(next);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  redirect(returnTo(form.get("next")) ?? "/today");
}

export async function requiredPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  const s = await getSession();
  if (!s || !s.mfaVerified) redirect("/login");
  const current = String(form.get("current") ?? "");
  const next = String(form.get("new") ?? "");
  if (next !== String(form.get("confirm") ?? "")) return { error: "The two new passwords do not match." };
  try {
    const meta = await requestMeta();
    await changePassword(s.user.id, current, next, meta);
    await revokeAllSessions(s.user.id);
    await setSessionCookie(await createSession(s.user.id, { orgId: s.ctx?.orgId ?? null, mfaVerified: true, ...meta }));
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  redirect(returnTo(form.get("next")) ?? "/today");
}

export async function logoutAction() {
  const token = await sessionToken();
  if (token) await revokeSession(token);
  await clearSessionCookie();
  redirect("/login");
}

export async function startMfaEnrollmentAction(): Promise<FormState> {
  const s = await getSession();
  if (!s || !s.mfaVerified) redirect("/login");
  let enrollment: Awaited<ReturnType<typeof beginMfaEnrollment>>;
  try {
    enrollment = await beginMfaEnrollment(s.user.id);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  const { secret, secretEnc } = enrollment;
  const secure = getEnv().APP_URL.startsWith("https://");
  (await cookies()).set("li_mfa_enroll", secretEnc, { httpOnly: true, secure, sameSite: "lax", path: "/account", maxAge: 600 });
  return { ok: true, data: { secret, url: otpauthUrl(secret, s.user.email) } };
}

export async function confirmMfaEnrollmentAction(_: FormState, form: FormData): Promise<FormState> {
  const s = await getSession();
  if (!s || !s.mfaVerified) redirect("/login");
  const jar = await cookies();
  const enc = jar.get("li_mfa_enroll")?.value;
  if (!enc) return { error: "The setup key expired. Start again." };
  try {
    await confirmMfaEnrollment(s.user.id, enc, String(form.get("code") ?? ""));
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  jar.delete({ name: "li_mfa_enroll", path: "/account" });
  // Other sessions predate MFA: revoke them, keep this one.
  await revokeAllSessions(s.user.id);
  await setSessionCookie(await createSession(s.user.id, { orgId: s.org?.id, mfaVerified: true, ...(await requestMeta()) }));
  const next = String(form.get("next") ?? "");
  redirect(next.startsWith("/constituent-center/") ? next : "/today");
}
