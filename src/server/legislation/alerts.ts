import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant } from "../db/client";
import { billActions, billAlertRules, bills, follows, notifications, organizations, trackedBills, type ActionClass, type BillAlertKind } from "../db/schema";

const ALERT_LABEL: Partial<Record<ActionClass, string>> = {
  introduced: "Introduced", referred: "Referred to committee", committee_action: "Committee action", hearing_scheduled: "Hearing scheduled",
  amendment: "Amendment", chamber_vote: "Chamber vote", passed: "Passed", failed: "Failed", signed: "Signed into law", vetoed: "Vetoed",
};
const PRIORITY: ActionClass[] = [
  "signed", "vetoed", "failed", "passed", "chamber_vote", "hearing_scheduled", "amendment", "committee_action", "referred", "introduced",
];

function alertKind(classes: ActionClass[]) {
  return PRIORITY.find((c) => classes.includes(c)) ?? "other";
}

// Alerts come only from synced provider actions, never from mail or model output.
async function createAlertsForActions(actionIds: string[]) {
  if (!actionIds.length) return { notifications: 0 };
  const db = await systemDb();
  const rows = await db
    .select({
      actionId: billActions.id, billId: billActions.billId, date: billActions.actionDate, description: billActions.description,
      classification: billActions.classification, identifier: bills.identifier,
    })
    .from(billActions)
    .innerJoin(bills, eq(bills.id, billActions.billId))
    .where(inArray(billActions.id, actionIds));
  const billIds = [...new Set(rows.map((r) => r.billId))];
  const tracking = billIds.length
    ? await db.select({ orgId: trackedBills.organizationId, billId: trackedBills.billId }).from(trackedBills).where(inArray(trackedBills.billId, billIds))
    : [];
  const billFollows = billIds.length
    ? await db
        .select({ orgId: follows.organizationId, userId: follows.userId, key: follows.targetKey })
        .from(follows)
        .where(and(eq(follows.targetType, "bill"), inArray(follows.targetKey, billIds)))
    : [];

  type N = typeof notifications.$inferInsert;
  const byOrg = new Map<string, N[]>();
  const push = (orgId: string, n: N) => byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), n]);
  for (const r of rows) {
    const kind = alertKind(r.classification);
    const label = kind === "other" ? "New action" : ALERT_LABEL[kind]!;
    const base = {
      kind: `bill.${kind}`, title: `${r.identifier}: ${label}`, body: `${r.description} (${r.date})`,
      link: `/bills/${r.billId}`, sourceType: "bill_action", sourceId: r.actionId,
    };
    const key = `bill-action:${r.actionId}`;
    for (const t of tracking.filter((t) => t.billId === r.billId)) push(t.orgId, { ...base, organizationId: t.orgId, userId: null, dedupeKey: key });
    for (const f of billFollows.filter((f) => f.key === r.billId)) {
      push(f.orgId, { ...base, organizationId: f.orgId, userId: f.userId, dedupeKey: `${key}:user:${f.userId}` });
    }
  }
  let created = 0;
  for (const [orgId, list] of byOrg) {
    const inserted = await withTenant({ orgId }, (tx) => tx.insert(notifications).values(list).onConflictDoNothing().returning({ id: notifications.id }));
    created += inserted.length;
  }
  return { notifications: created };
}

export async function handleLegislativeAlerts(p: Record<string, unknown>) {
  return createAlertsForActions((p.actionIds as string[]) ?? []);
}

const ALERT_RULE_LABEL: Record<BillAlertKind, string> = { keyword: "keyword", code: "code section", subject: "subject", sponsor: "sponsor" };
const OUTER_BILL_ID = sql.raw('"bills"."id"');

// The same match as the Bills search, so an alert and its matching list agree.
function alertRuleMatches(kind: BillAlertKind, value: string): SQL {
  const sponsor = sql`exists (select 1 from bill_sponsors s where s.bill_id = ${OUTER_BILL_ID} and s.name ilike ${`%${value}%`})`;
  if (kind === "keyword") return sql`(${bills.searchTsv} @@ websearch_to_tsquery('english', ${value}) or ${sponsor})`;
  if (kind === "code") return sql`${value} = any(${bills.codeSections})`;
  if (kind === "subject") return sql`${value} = any(${bills.subjects})`;
  return sponsor;
}

export async function matchAlertRules(jurisdiction: string) {
  const db = await systemDb();
  const rules = await db
    .select({
      id: billAlertRules.id, orgId: billAlertRules.organizationId, kind: billAlertRules.kind, value: billAlertRules.value, createdAt: billAlertRules.createdAt,
    })
    .from(billAlertRules)
    .innerJoin(organizations, eq(organizations.id, billAlertRules.organizationId))
    .where(and(eq(billAlertRules.active, true), eq(organizations.jurisdictionCode, jurisdiction)));
  let created = 0;
  for (const r of rules) {
    const found = await db
      .select({ id: bills.id, identifier: bills.identifier, title: bills.title })
      .from(bills)
      .where(and(eq(bills.jurisdictionCode, jurisdiction), gt(bills.createdAt, r.createdAt), alertRuleMatches(r.kind, r.value)))
      .limit(200);
    if (!found.length) continue;
    const rows = found.map((b) => ({
      organizationId: r.orgId, userId: null, kind: "bill.alert", title: `${b.identifier}: new bill matches your alert`,
      body: `${b.title} (${ALERT_RULE_LABEL[r.kind]}: ${r.value})`, link: `/bills/${b.id}`, sourceType: "bill_alert_rule", sourceId: r.id,
      dedupeKey: `alert-rule:${r.id}:${b.id}`,
    }));
    const inserted = await withTenant({ orgId: r.orgId }, async (tx) => {
      const added = await tx.insert(notifications).values(rows).onConflictDoNothing().returning({ id: notifications.id });
      if (added.length) await tx.update(billAlertRules).set({ lastMatchedAt: new Date() }).where(eq(billAlertRules.id, r.id));
      return added;
    });
    created += inserted.length;
  }
  return { notifications: created };
}
