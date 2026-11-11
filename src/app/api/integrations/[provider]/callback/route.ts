import { NextResponse } from "next/server";
import { getSession } from "@/server/auth/next";
import { completeMailboxConnection, linkErrorCode } from "@/server/email/connections";
import { proveSending } from "@/server/email/sending";
import { APPROVAL_STATE } from "@/server/email/providers/graph";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";

// Shown to an outside IT admin with no account here, so it is a page of its own.
function approvalPage(approved: boolean) {
  const title = approved ? "Constituent Center is approved for your organization" : "Constituent Center was not approved";
  const body = approved
    ? "Staff can now link their Outlook mailbox in Settings with Connect Outlook. It can read mail and nothing else. You can close this page."
    : "Nothing was changed. The link can be opened again by an administrator of your Microsoft 365 organization.";
  const html = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="robots" content="noindex"><title>${title}</title></head>`,
    `<body style="margin:0;background:#f8f9f6;color:#111c36;font:18px/1.5 Georgia,serif"><main style="max-width:38rem;margin:0 auto;padding:4rem 1.5rem">`,
    `<h1 style="font:600 2rem/1.15 system-ui,sans-serif;margin:0 0 1rem">${title}</h1><p style="margin:0">${body}</p></main></body></html>`].join("");
  return new NextResponse(html, { status: approved ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// OAuth redirect target, bound to the user who started the flow.
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const base = getEnv().APP_URL;
  if (provider !== "google" && provider !== "microsoft") return NextResponse.redirect(`${base}/constituent-center/setup?error=unknown_provider`);
  const url = new URL(request.url);
  if (provider === "microsoft" && url.searchParams.get("state") === APPROVAL_STATE) {
    return approvalPage(/^true$/i.test(url.searchParams.get("admin_consent") ?? "") && !url.searchParams.get("error"));
  }
  const s = await getSession();
  // No two-step check here: linking a mailbox is what turns it on.
  if (!s?.ctx || s.passwordChangeRequired) return NextResponse.redirect(`${base}/login`);
  const err = url.searchParams.get("error");
  if (err) {
    // Microsoft sends access_denied on Cancel and when admin approval is needed.
    const reason = err === "access_denied" ? (provider === "microsoft" ? "denied_microsoft" : "denied") : "auth_failed";
    return NextResponse.redirect(`${base}/constituent-center/setup?error=${reason}#link`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return NextResponse.redirect(`${base}/constituent-center/setup?error=missing_code`);
  try {
    const { next, sendFor, connection } = await completeMailboxConnection(provider, code, state, s.ctx.userId);
    if (sendFor && connection.organizationId === s.ctx.orgId) await proveSending(s.ctx, connection);
    return NextResponse.redirect(`${base}${next}`);
  } catch (e) {
    logger.error("oauth.callback_failed", { provider, message: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return NextResponse.redirect(`${base}/constituent-center/setup?error=${linkErrorCode(e)}`);
  }
}
