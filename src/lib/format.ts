export const DISPLAY_TIME_ZONE = process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "America/New_York";
const timeZone = DISPLAY_TIME_ZONE;
const dtf = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
const dtfYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
const yf = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone });
const tf = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  // Date-only values sit at noon UTC so they land on the same day in US zones.
  return d instanceof Date ? d : new Date(d.length === 10 ? `${d}T12:00:00Z` : d);
}

export function shortDate(input: Date | string | null | undefined, now = new Date()) {
  const d = toDate(input);
  if (!d) return "Not recorded";
  if (dtfYear.format(d) === dtfYear.format(now)) return tf.format(d);
  return yf.format(d) === yf.format(now) ? dtf.format(d) : dtfYear.format(d);
}

export function fullDate(input: Date | string | null | undefined) {
  const d = toDate(input);
  return d ? `${dtfYear.format(d)}, ${tf.format(d)}` : "Not recorded";
}

export function dateOnly(input: Date | string | null | undefined) {
  const d = toDate(input);
  return d ? dtfYear.format(d) : "Not recorded";
}

export function relative(input: Date | string | null | undefined, now = Date.now()) {
  const d = toDate(input);
  if (!d) return "never";
  const s = Math.round((now - d.getTime()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return "just now";
  const out = abs < 3600 ? plural(Math.round(abs / 60), "min") : abs < 86400 ? plural(Math.round(abs / 3600), "hour") : plural(Math.round(abs / 86400), "day");
  return s >= 0 ? `${out} ago` : `in ${out}`;
}

export function waited(input: Date | string | null | undefined, now = Date.now()) {
  const d = toDate(input);
  if (!d) return "";
  const m = Math.max(0, Math.floor((now - d.getTime()) / 60_000));
  if (m < 1) return "less than a minute";
  if (m < 60) return plural(m, "minute");
  return m < 2880 ? plural(Math.floor(m / 60), "hour") : plural(Math.floor(m / 1440), "day");
}

export const sentence = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Server components read the clock here so render-purity lint rules stay useful.
export const nowMs = () => Date.now();
export const isoDaysAgo = (days: number) => new Date(nowMs() - days * 86400_000).toISOString().slice(0, 10);

const wdf = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
const keyf = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });

export function dayKey(input: Date | string) {
  return keyf.format(toDate(input)!);
}

export function dayLabel(input: Date | string | null | undefined, now = new Date()) {
  const d = toDate(input);
  if (!d) return "Not recorded";
  const diff = Math.round((Date.parse(dayKey(d)) - Date.parse(dayKey(now))) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return yf.format(d) === yf.format(now) ? wdf.format(d) : dtfYear.format(d);
}

export function isDateOnly(input: Date | string | null | undefined) {
  const d = toDate(input);
  return Boolean(d) && tf.format(d!) === "12:00 AM";
}

export function timeOnly(input: Date | string | null | undefined) {
  const d = toDate(input);
  return d ? tf.format(d) : "Not recorded";
}

export function eventTime(input: Date | string | null | undefined, now = new Date()) {
  const d = toDate(input);
  if (d && isDateOnly(d)) return dayLabel(d, now);
  return d ? `${dayLabel(d, now)}, ${tf.format(d)}` : "Not recorded";
}
