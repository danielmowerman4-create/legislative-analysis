import { RetryLaterError } from "../../jobs/queue";
import type { FetchLike } from "../../http";

let fetchOverride: FetchLike | null = null;
export function setProviderFetchForTests(f: FetchLike | null) {
  fetchOverride = f;
}
export const providerFetch: FetchLike = (input, init) => (fetchOverride ?? fetch)(input, init);

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}
export class CursorExpiredError extends Error {}

// Google limits per minute and sends no Retry-After, so wait just over one.
const UNNAMED_WAIT_MS = 65_000;

function retryAfterMs(res: Response) {
  const h = res.headers.get("retry-after");
  if (!h) return UNNAMED_WAIT_MS;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.min(secs * 1000, 15 * 60_000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? UNNAMED_WAIT_MS : Math.max(1000, at - Date.now());
}

// Google sends some rate limits as 403 with one of these reasons.
const RATE_LIMIT_REASON = /rate_?limit|quotaExceeded|dailyLimit/i;

type ErrorBody = {
  error?: { code?: string | number; status?: string; message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } | string;
  error_description?: string;
};

export async function checked(res: Response, context: string): Promise<Response> {
  if (res.ok) return res;
  let code = String(res.status);
  let reason: string | null = null;
  try {
    const body = (await res.clone().json()) as ErrorBody;
    if (typeof body.error === "string") code = body.error;
    else {
      if (body.error?.status) code = String(body.error.status);
      else if (body.error?.code) code = String(body.error.code);
      const word = body.error?.errors?.find((e) => e.reason)?.reason ?? body.error?.details?.find((d) => d.reason)?.reason;
      // Keep only a short code word; a provider's message could name a mailbox.
      if (typeof word === "string" && /^[\w.-]{1,60}$/.test(word)) reason = word;
    }
  } catch {}
  if (res.status === 429 || res.status === 503 || (res.status === 403 && reason && RATE_LIMIT_REASON.test(reason))) {
    throw new RetryLaterError(`${context}: provider rate limit (${res.status}${reason ? ` ${reason}` : ""})`, retryAfterMs(res));
  }
  throw new ProviderHttpError(res.status, code, `${context} failed (${res.status} ${code}${reason ? ` ${reason}` : ""})`, reason);
}

export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt: Date; scopes: string[] };

export async function requestTokens(url: string, context: string, body: Record<string, string>): Promise<TokenSet> {
  const res = await checked(
    await providerFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
    context,
  );
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  const expiresAt = new Date(Date.now() + (j.expires_in - 60) * 1000);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt, scopes: (j.scope ?? "").split(" ").filter(Boolean) };
}
