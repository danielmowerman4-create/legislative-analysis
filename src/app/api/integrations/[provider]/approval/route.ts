import { NextResponse } from "next/server";
import { microsoftApprovalUrl } from "@/server/email/providers/graph";
import { integrationsConfigured } from "@/server/env";

// No sign-in: it only forwards an IT admin to Microsoft's approval page for this app.
export async function GET(_request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "microsoft" || !integrationsConfigured().microsoft) return NextResponse.json({ error: "not available" }, { status: 404 });
  return NextResponse.redirect(microsoftApprovalUrl());
}
