import { NextResponse } from "next/server";
import { officeContextOrThrow } from "@/server/auth/next";
import { searchEverything } from "@/server/search/legislation";

export async function GET(request: Request) {
  const ctx = await officeContextOrThrow().catch(() => null);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const { results } = await searchEverything(ctx, q);
  return NextResponse.json({ results: results.map(({ type, id, title, subtitle, href }) => ({ type, id, title, subtitle, href })) },
    { headers: { "cache-control": "no-store" } });
}
