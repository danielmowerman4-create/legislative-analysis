// npx tsx scripts/smoke-routes.ts --email <member> [--expect "/path|text"] [--expect "/path|!text"]
import { parseArgs } from "node:util";
import { and, asc, eq, sql } from "drizzle-orm";
import { closeDb, systemDb } from "../src/server/db/client";
import {
  bills, cases, committees, contacts, emailMessages, legislators, memberships, officeSettings, organizations, templateClusters, trackedBills, users,
} from "../src/server/db/schema";
import { createSession, revokeSession, SESSION_COOKIE } from "../src/server/auth/sessions";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    expect: { type: "string", multiple: true, default: [] },
    base: { type: "string", default: `http://127.0.0.1:${process.env.PORT ?? 3000}` },
  },
});

const PAGES = [
  "/today", "/bills", "/bills?view=tracked", "/bills?view=hearings", "/bills?view=committees", "/bills?view=enacted", "/bills?view=onechamber",
  "/bills?view=dead", "/bills?q=school", "/tracked", "/tracked?group=stage", "/calendar", "/calendar?scope=tracked", "/compare", "/committees",
  "/legislators", "/scorecards", "/scorecards?sort=opponents", "/alerts", "/reports", "/notifications", "/settings", "/team", "/help", "/account/mfa",
  "/api/search?q=school", "/api/export/tracked", "/api/export/calendar", "/calendar?scope=all", "/api/export/calendar?scope=mine", "/press",
];
const BILL_TABS = ["", "?tab=timeline", "?tab=text", "?tab=votes", "?tab=related", "?tab=notes", "/compare", "/whip", "/whip?chamber=upper"];

const CENTER = "/constituent-center";
const CENTER_PAGES = [
  "", "/mail", "/mail?folder=new", "/mail?stance=support", "/form-letters", "/casework", "/people", "/replies", "/replies?view=sent", "/topics", "/every-message", "/setup",
].map((p) => `${CENTER}${p}`);

async function check(path: string, cookie: string | null) {
  const res = await fetch(`${values.base}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const body = await res.text();
  // A server render error ships Next's error document; a sign-in bounce is a redirect.
  const ok = res.status === 200 && !body.includes('id="__next_error__"');
  console.log(`${ok ? "ok  " : "FAIL"} ${res.status} ${path}${res.status >= 300 && res.status < 400 ? ` -> ${res.headers.get("location")}` : ""}`);
  return ok;
}

async function expectText(spec: string, cookie: string) {
  const [path, raw] = spec.split("|");
  const absent = raw.startsWith("!");
  const text = absent ? raw.slice(1) : raw;
  const res = await fetch(`${values.base}${path}`, { headers: { cookie }, redirect: "manual" });
  const ok = res.status === 200 && (await res.text()).includes(text) !== absent;
  console.log(`${ok ? "ok  " : "FAIL"} ${res.status} ${path} ${absent ? "lacks" : "has"} "${text}"`);
  return ok;
}

async function main() {
  if (!values.email) throw new Error("--email is required");
  const db = await systemDb();
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, values.email.toLowerCase()));
  if (!user) throw new Error(`No user ${values.email}`);
  const [m] = await db
    .select({ orgId: memberships.organizationId, jurisdiction: organizations.jurisdictionCode })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, "active")));
  if (!m) throw new Error(`${values.email} has no office`);

  const first = async <T>(q: Promise<T[]>) => (await q)[0];
  const inState = eq(bills.jurisdictionCode, m.jurisdiction);
  const tracked = db.select({ id: bills.id }).from(trackedBills).innerJoin(bills, eq(bills.id, trackedBills.billId));
  const bill = await first(tracked.where(eq(trackedBills.organizationId, m.orgId)).orderBy(asc(bills.identifier)).limit(1));
  const anyBill = bill ?? (await first(db.select({ id: bills.id }).from(bills).where(inState).orderBy(asc(bills.identifier)).limit(1)));
  const other = anyBill ? await first(db.select({ id: bills.id }).from(bills).where(and(inState, sql`${bills.id} <> ${anyBill.id}`)).limit(1)) : undefined;
  const committee = await first(db.select({ id: committees.id }).from(committees).where(eq(committees.jurisdictionCode, m.jurisdiction)).limit(1));
  const person = await first(db.select({ id: legislators.id }).from(legislators).where(eq(legislators.jurisdictionCode, m.jurisdiction)).limit(1));
  const pages = [
    ...PAGES,
    ...(anyBill ? BILL_TABS.map((t) => `/bills/${anyBill.id}${t}`) : []),
    ...(anyBill && other ? [`/compare?a=${anyBill.id}`, `/compare?a=${anyBill.id}&b=${other.id}`] : []),
    ...(committee ? [`/committees/${committee.id}`] : []),
    ...(person ? [`/legislators/${person.id}`] : []),
  ];

  const [settings] = await db.select({ on: officeSettings.centerEnabled }).from(officeSettings).where(eq(officeSettings.organizationId, m.orgId));
  if (settings?.on) {
    const message = await first(db.select({ id: emailMessages.id }).from(emailMessages).where(eq(emailMessages.organizationId, m.orgId)).limit(1));
    const contact = await first(db.select({ id: contacts.id }).from(contacts).where(eq(contacts.organizationId, m.orgId)).limit(1));
    const kase = await first(db.select({ id: cases.id }).from(cases).where(eq(cases.organizationId, m.orgId)).limit(1));
    const cluster = await first(db.select({ id: templateClusters.id }).from(templateClusters).where(eq(templateClusters.organizationId, m.orgId)).limit(1));
    const link = (row: { id: string } | undefined, path: string) => (row ? [`${CENTER}/${path}/${row.id}`] : []);
    pages.push(...CENTER_PAGES, ...link(message, "mail"), ...link(contact, "people"), ...link(kase, "casework"), ...link(cluster, "form-letters"));
  }

  let failed = 0;
  if (!(await check("/login", null))) failed++;
  if (!(await check("/api/health", null))) failed++;
  const token = await createSession(user.id, { orgId: m.orgId, mfaVerified: true, userAgent: "smoke-routes" });
  try {
    for (const p of pages) if (!(await check(p, `${SESSION_COOKIE}=${token}`))) failed++;
    for (const spec of values.expect) if (!(await expectText(spec, `${SESSION_COOKIE}=${token}`))) failed++;
  } finally {
    await revokeSession(token);
  }
  console.log(`${pages.length + 2 - failed}/${pages.length + 2} pages ok`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
