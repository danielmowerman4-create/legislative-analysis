import { NextResponse } from "next/server";
import { processGraphNotifications } from "@/server/email/webhooks";

// Graph handshake echoes validationToken; notifications are checked by clientState.
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token) return new NextResponse(token.slice(0, 1024), { status: 200, headers: { "content-type": "text/plain" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }
  const r = await processGraphNotifications(body);
  return new NextResponse(null, { status: r.rejected && !r.enqueued ? 403 : 202 });
}
