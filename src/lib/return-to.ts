// A plain in-app path only: no query string, since a search can hold a person's name.
export function returnTo(value: unknown): string | null {
  const v = typeof value === "string" ? value : "";
  if (v.length < 2 || v.length > 200 || !/^\/[A-Za-z0-9\-._~%/]*$/.test(v) || v.startsWith("//")) return null;
  if (/^\/(?:login|api|_next|no-office|account\/mfa|account\/password)(?:\/|$)/.test(v)) return null;
  return v;
}
