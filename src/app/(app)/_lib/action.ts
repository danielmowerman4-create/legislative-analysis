import "server-only";
import { revalidatePath } from "next/cache";
import { officeContextOrThrow } from "@/server/auth/next";
import { AppError } from "@/server/errors";
import type { OfficeContext } from "@/server/authz/context";
import { logger } from "@/server/logger";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

export async function act<T>(fn: (ctx: OfficeContext) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const ctx = await officeContextOrThrow();
    return { ok: true, data: await fn(ctx) };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    // Next.js redirect/notFound are thrown errors that must propagate.
    if (e && typeof e === "object" && "digest" in e && String((e as { digest?: string }).digest).startsWith("NEXT_")) throw e;
    logger.error("action.failed", { message: (e as Error).message?.slice(0, 300) });
    return { ok: false, error: "Something went wrong. The change was not saved." };
  }
}

export async function actAndRevalidate<T>(path: string, fn: (ctx: OfficeContext) => Promise<T>): Promise<ActionResult<T>> {
  const r = await act(fn);
  revalidatePath(path);
  return r;
}
