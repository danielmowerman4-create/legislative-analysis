import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { systemDb, dbKind } from "@/server/db/client";

// Public liveness check: reveals no configuration or data.
export async function GET() {
  try {
    const db = await systemDb();
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: await dbKind() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
