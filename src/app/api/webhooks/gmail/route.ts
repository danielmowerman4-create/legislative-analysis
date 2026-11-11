import { NextResponse } from "next/server";
import { processGmailPush, verifyPubsubToken } from "@/server/email/webhooks";
import { logger } from "@/server/logger";

export async function POST(request: Request) {
  if (!(await verifyPubsubToken(request.headers.get("authorization")))) {
    logger.warn("webhook.gmail.unverified");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }
  const r = await processGmailPush(body);
  return new NextResponse(null, { status: r.status });
}
