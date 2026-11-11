import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getEnv } from "../env";
import { AppError } from "../errors";
import { loadSession, SESSION_ABSOLUTE_MS, SESSION_COOKIE, type LoadedSession } from "./sessions";
import { officeGate } from "./gate";

// The edge sets x-real-ip; the right-most x-forwarded-for entry is our proxy's.
export function clientIp(h: Headers): string | null {
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").pop()?.trim() || null;
}

export async function requestMeta() {
  const h = await headers();
  return { ip: clientIp(h), userAgent: h.get("user-agent") };
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, secure: getEnv().APP_URL.startsWith("https://"), sameSite: "lax", path: "/", maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export const getSession = cache(async (): Promise<LoadedSession | null> => loadSession(await sessionToken()));

type OfficeSession = LoadedSession & { ctx: NonNullable<LoadedSession["ctx"]>; org: NonNullable<LoadedSession["org"]> };

export async function requireOffice(): Promise<OfficeSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!s.mfaVerified) redirect("/login/mfa");
  if (s.passwordChangeRequired) redirect("/account/password");
  if (s.mfaRequiredByOffice) redirect("/account/mfa?required=1");
  if (!s.ctx || !s.org) redirect("/no-office");
  return s as OfficeSession;
}

export async function officeContextOrThrow() {
  const s = await getSession();
  const gate = officeGate(s);
  if (gate === "password_required") throw new AppError("unauthorized", "Choose your own password first.");
  if (gate !== "open") throw new AppError("unauthorized", "Sign in again.");
  return s!.ctx!;
}

export async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
}
