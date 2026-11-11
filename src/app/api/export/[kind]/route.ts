import { NextResponse } from "next/server";
import { officeContextOrThrow } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { listEvents, POSITION_LABEL, PRIORITY_LABEL, trackedReport } from "@/server/services/legislation";
import { STATUS_LABEL } from "@/server/legislation/normalize";
import { dayKey, DISPLAY_TIME_ZONE, isDateOnly } from "@/lib/format";
import { whipBoard } from "@/server/services/tools";
import { WHIP_LABEL } from "@/lib/whip";
import { withTenant } from "@/server/db/client";
import { audit } from "@/server/services/audit";
import { getEnv } from "@/server/env";
import { AppError } from "@/server/errors";
import { csvFile, toCsv } from "@/app/(app)/_lib/csv";

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// RFC 5545 folds content lines longer than 75 octets.
const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const hearingTime = (s: string) => new Date(s).toLocaleString("en-US", { timeZone: DISPLAY_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });

async function exportFile(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  // Same gates as every page: signed in, two-step where required, own password.
  const ctx = await officeContextOrThrow().catch(() => null);
  if (!ctx || !can(ctx, "legislation.read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { kind } = await params;
  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);

  if (kind === "tracked") {
    if (!can(ctx, "reports.read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const filters = { position: url.searchParams.get("position") ?? undefined, priority: url.searchParams.get("priority") ?? undefined };
    const rows = await trackedReport(ctx, filters);
    type R = (typeof rows)[number];
    const csv = toCsv(
      [
        ["Bill", (r: R) => r.identifier],
        ["Title", (r: R) => r.title],
        ["Session", (r: R) => r.session],
        ["Position", (r: R) => POSITION_LABEL[r.position]],
        ["Priority", (r: R) => PRIORITY_LABEL[r.priority]],
        ["Status", (r: R) => r.statusText ?? STATUS_LABEL[r.status]],
        ["Last action date", (r: R) => r.lastActionAt],
        ["Last action", (r: R) => r.lastActionText],
        ["Next hearing", (r: R) => (r.nextEvent ? hearingTime(r.nextEvent) : "")],
        ["Lead sponsor", (r: R) => r.primarySponsor],
        ["Committee", (r: R) => r.committee],
        ["Why tracked", (r: R) => r.reason],
        ["Handled by", (r: R) => r.assignee],
        ["Next step", (r: R) => r.nextStep],
        ["Due", (r: R) => r.dueDate],
        ["Latest note", (r: R) => r.latestNote],
      ],
      rows,
    );
    await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => audit(tx, ctx, "report.exported", "report", "tracked", filters));
    return csvFile(csv, `tracked-bills-${today}.csv`);
  }

  if (kind === "whip") {
    const billId = url.searchParams.get("bill");
    if (!billId) return NextResponse.json({ error: "missing bill" }, { status: 400 });
    const w = await whipBoard(ctx, billId, { chamber: url.searchParams.get("chamber") ?? undefined });
    type R = (typeof w.rows)[number];
    const csv = toCsv(
      [
        ["Member", (r: R) => r.name],
        ["Party", (r: R) => r.party],
        ["District", (r: R) => r.district],
        ["Stance", (r: R) => WHIP_LABEL[r.stance]],
        ["Based on", (r: R) => r.basis],
        ["Note", (r: R) => r.note],
      ],
      w.rows,
    );
    await withTenant({ orgId: ctx.orgId, userId: ctx.userId }, (tx) => audit(tx, ctx, "report.exported", "report", "whip", { billId, chamber: w.chamber }));
    return csvFile(csv, `whip-${w.bill.identifier.replace(/\s+/g, "")}-${w.chamberName}-${today}.csv`);
  }

  if (kind === "calendar") {
    const trackedOnly = url.searchParams.get("scope") === "tracked";
    const events = await listEvents(ctx, { from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 60 * 86400_000), trackedOnly });
    const base = getEnv().APP_URL.replace(/\/$/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Legislative Analysis//Hearings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:Legislative hearings"];
    for (const e of events) {
      const bills = e.bills.map((b) => `${b.identifier} ${b.title}${b.position ? ` (${POSITION_LABEL[b.position]})` : ""}`);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${e.id}@legislative-intelligence`,
        `DTSTAMP:${icsTime(new Date())}`,
        ...(isDateOnly(e.startsAt)
          ? [`DTSTART;VALUE=DATE:${dayKey(e.startsAt).replace(/-/g, "")}`]
          : [`DTSTART:${icsTime(e.startsAt)}`, `DTEND:${icsTime(new Date(e.startsAt.getTime() + 3600_000))}`]),
        `SUMMARY:${icsText(bills.length ? `${e.title}: ${e.bills.map((b) => b.identifier).join(", ")}` : e.title)}`,
        ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
        `DESCRIPTION:${icsText(bills.join("\n"))}`,
        ...(e.bills[0] ? [`URL:${base}/bills/${e.bills[0].id}`] : []),
        `STATUS:${e.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    return new NextResponse(lines.map(fold).join("\r\n"), { headers: { "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="hearings-${today}.ics"`, "cache-control": "no-store" } });
  }

  return NextResponse.json({ error: "unknown export" }, { status: 404 });
}

export async function GET(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    return await exportFile(request, context);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.code }, { status: e.status });
    throw e;
  }
}
