type Problem = { operation: string; errorCode: string; message: string };

const NOT_ANSWERING = "The mail service did not answer when it was asked for mail. It is asked again every ten minutes.";
const LIMITED = "The mail service limits how fast mail can be read. The rest is being read in at that pace.";
const SIGN_IN_ENDED = "The sign-in for this mailbox has ended. Connect the mailbox again.";

const signInEnded = (text: string) => /revoked|reconnect|disconnected|permanent/i.test(text);

export function problemText(p: Problem): string | null {
  switch (p.operation) {
    case "backfill":
    case "incremental":
    case "reconcile":
      return p.errorCode === "RetryLaterError" ? LIMITED : signInEnded(p.errorCode) ? SIGN_IN_ENDED : NOT_ANSWERING;
    case "rate_limit":
      return LIMITED;
    case "fetch_message":
      return p.errorCode === "unparseable" ? p.message : "Some messages could not be fetched from the mailbox. They are asked for again every ten minutes and are listed under Every message.";
    case "token_refresh":
      return SIGN_IN_ENDED;
    case "renew_subscription":
      return "New mail may take up to ten minutes to appear.";
    case "cursor_expired":
      return null;
    default:
      return p.message;
  }
}

export const lastErrorText = (raw: string) => (/rate limit/i.test(raw) ? LIMITED : signInEnded(raw) ? SIGN_IN_ENDED : NOT_ANSWERING);

export function problemLines<T extends Problem & { id: string; lastSeenAt: Date }>(rows: T[]) {
  const seen = new Set<string>();
  const lines: { id: string; text: string; lastSeenAt: Date }[] = [];
  for (const r of [...rows].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())) {
    const text = problemText(r);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push({ id: r.id, text, lastSeenAt: r.lastSeenAt });
  }
  return lines;
}
