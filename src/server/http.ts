import { RetryLaterError } from "./jobs/queue";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  ) {
    super(message);
  }
}

function retryAfterMs(res: Response) {
  const h = res.headers.get("retry-after");
  if (!h) return 30_000;
  const secs = Number(h);
  if (!Number.isNaN(secs)) return Math.min(secs * 1000, 15 * 60_000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? 30_000 : Math.max(1000, at - Date.now());
}

export async function checked(res: Response, context: string): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 429 || res.status === 503) throw new RetryLaterError(`${context}: provider rate limit (${res.status})`, retryAfterMs(res));
  let code = String(res.status);
  try {
    const body = (await res.clone().json()) as { error?: { code?: string | number; status?: string; message?: string } | string; error_description?: string };
    if (typeof body.error === "string") code = body.error;
    else if (body.error?.status) code = String(body.error.status);
    else if (body.error?.code) code = String(body.error.code);
  } catch {}
  throw new ProviderHttpError(res.status, code, `${context} failed (${res.status} ${code})`);
}
