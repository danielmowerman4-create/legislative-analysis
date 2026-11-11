import "server-only";
import { NextResponse } from "next/server";

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Someone else's text must never run as a spreadsheet formula.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function toCsv<R>(columns: [string, (r: R) => unknown][], rows: R[], { header = false } = {}) {
  const kept = header && !rows.length ? columns : columns.filter(([, get]) => rows.some((r) => String(get(r) ?? "").trim() !== ""));
  return [kept.map(([h]) => h), ...rows.map((r) => kept.map(([, get]) => get(r)))].map((line) => line.map(csvCell).join(",")).join("\r\n");
}

export const csvFile = (csv: string, filename: string) => new NextResponse(csv,
  { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
