import { NextResponse } from "next/server";
import { officeContextOrThrow } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { AppError } from "@/server/errors";
import { BILL_REQUEST_LABEL, STAFF_CATEGORIES, staffCategoryOf } from "@/server/classification/categories";
import { billPositionsForExport, centerEnabled, mailForExport } from "@/server/services/center";
import { csvFile, toCsv } from "@/app/(app)/_lib/csv";
import { dayKey } from "@/lib/format";

const day = (d: Date | string | null) => (d ? dayKey(new Date(d)) : "");
const DISTRICT: Record<string, string> = { in_district: "In district", outside: "Outside the district", out_of_state: "Out of state" };
const STANCE: Record<string, string> = { support: "Supports", oppose: "Opposes", mixed: "Mixed", neutral: "Asks about", unclear: "Mentions" };
const STATUS: Record<string, string> = { new: "New", in_progress: "In progress", done: "Done" };
const yes = (b: boolean) => (b ? "Yes" : "");

export async function GET(_request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const ctx = await officeContextOrThrow().catch(() => null);
  if (!ctx || !can(ctx, "inbox.read") || !can(ctx, "records.export") || !(await centerEnabled(ctx.orgId))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { kind } = await params;
  const today = dayKey(new Date());
  const file = (name: string, csv: string) => csvFile(csv, `${name}-${today}.csv`);
  try {
    if (kind === "mail") {
      const rows = await mailForExport(ctx);
      type R = (typeof rows)[number];
      return file(
        "constituent-mail",
        toCsv<R>(
          [
            ["Received", (r) => day(r.received_at)],
            ["Name", (r) => r.name],
            ["Email", (r) => r.address],
            ["Subject", (r) => r.subject],
            ["Kind", (r) => STAFF_CATEGORIES[staffCategoryOf(r.message_types as never, r.is_internal)]],
            ["Issues", (r) => r.issues],
            ["Bills", (r) => r.bills],
            ["District", (r) => (r.district_status ? DISTRICT[r.district_status] : "")],
            ["Form letter", (r) => yes(r.form_letter)],
            ["Status", (r) => STATUS[r.triage_status] ?? r.triage_status],
            ["Answered", (r) => day(r.answered_at)],
          ],
          rows,
          { header: true },
        ),
      );
    }
    if (kind === "bills") {
      const rows = await billPositionsForExport(ctx);
      type R = (typeof rows)[number];
      return file(
        "bill-positions",
        toCsv<R>(
          [
            ["Bill", (r) => r.reference],
            ["Title", (r) => r.title],
            ["Name", (r) => r.name],
            ["Email", (r) => r.address],
            ["Stance", (r) => STANCE[r.position] ?? r.position],
            ["Asks for", (r) => (r.requested_action ? ((BILL_REQUEST_LABEL as Record<string, string>)[r.requested_action] ?? r.requested_action) : "")],
            ["District", (r) => (r.district_status ? DISTRICT[r.district_status] : "")],
            ["Form letter", (r) => yes(r.form_letter)],
            ["Received", (r) => day(r.received_at)],
          ],
          rows,
          { header: true },
        ),
      );
    }
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.code }, { status: e.status });
    throw e;
  }
  return NextResponse.json({ error: "unknown export" }, { status: 404 });
}
