import { createHash } from "node:crypto";
import { runPipeline, type PipelineDeps } from "../../src/server/classification/pipeline";
import { flattenTaxonomy } from "../../src/server/classification/default-taxonomy";
import { sessionsInScope, type BillCandidate } from "../../src/server/classification/bills";
import type { SessionBill } from "../../src/server/classification/bill-matching";
import type { ClassificationResult } from "../../src/server/classification/schema";
import { demoLegislativeDataset } from "../../src/server/demo/legislative-fixture";
import { EVAL_CASES, EVAL_DEFAULT_SENT_AT, type EvalCase } from "./dataset";

const uuidFor = (s: string) => {
  const h = createHash("sha1").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const FIXTURE_NOW = new Date("2026-11-06T12:00:00Z");
const ds = demoLegislativeDataset(FIXTURE_NOW);
const sessions = new Map(ds.sessions.map((s) => [s.providerId, s]));
const CANDIDATES: (BillCandidate & { key: string })[] = ds.bills.map((b) => ({
  key: b.providerBillId,
  id: uuidFor(b.providerBillId),
  identifier: b.identifier,
  jurisdictionCode: "ZZ",
  sessionIdentifier: sessions.get(b.sessionProviderId)!.identifier,
  sessionStart: sessions.get(b.sessionProviderId)!.startDate,
  sessionEnd: sessions.get(b.sessionProviderId)!.endDate,
  title: b.title,
  summary: b.officialSummary,
  subjects: b.subjects,
  sponsorNames: b.sponsors.map((s) => s.name),
}));
const keyForId = new Map(CANDIDATES.map((c) => [c.id, c.key]));
const numbered = (identifier: string) => ({ billType: identifier.split(" ")[0], number: Number(identifier.split(" ")[1]) });
const SESSION_BILLS: (SessionBill & { session: string })[] = ds.bills.map((b) => ({ id: uuidFor(b.providerBillId), identifier: b.identifier,
  ...numbered(b.identifier), title: b.title, sessionIdentifier: sessions.get(b.sessionProviderId)!.identifier, session: b.sessionProviderId }));

export const EVAL_DEPS: PipelineDeps = {
  taxonomy: flattenTaxonomy(),
  officeJurisdiction: "ZZ",
  office: {
    internalDomains: ["house.example.gov"],
    legislatureDomains: ["legis.example.gov"],
    agencies: [
      { name: "Demo State Department of Labor", abbreviation: "DSDOL", domains: ["labor.demo.gov"] },
      { name: "Demo State Division of Motor Vehicles", abbreviation: "DMV", domains: [] },
      { name: "Demo State Department of Health Services", abbreviation: "DHS", domains: [] },
      { name: "Demo State Department of Revenue", abbreviation: "DOR", domains: [] },
    ],
  },
  thresholds: { issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 },
  findBillCandidates: async (refs) => CANDIDATES.filter((c) => refs.includes(c.identifier)),
  sessionScope: async (at) => {
    const inScope = sessionsInScope(ds.sessions, at);
    return {
      bills: SESSION_BILLS.filter((b) => inScope.some((x) => x.providerId === b.session)),
      sessions: inScope.map((x) => x.identifier),
    };
  },
  ai: null,
};

type PRF = { tp: number; fp: number; fn: number };
const prf = (m: PRF) => {
  const p = m.tp + m.fp ? m.tp / (m.tp + m.fp) : 1;
  const r = m.tp + m.fn ? m.tp / (m.tp + m.fn) : 1;
  return { precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, ...m };
};
const add = (m: PRF, pred: string[], gold: string[]) => {
  for (const x of pred) m[gold.includes(x) ? "tp" : "fp"]++;
  for (const x of gold) if (!pred.includes(x)) m.fn++;
};

export type CaseResult = { c: EvalCase; r: ClassificationResult; errors: string[] };

export async function evaluate(split: "dev" | "test" | "all") {
  const cases = EVAL_CASES.filter((c) => split === "all" || c.split === split);
  const types: PRF = { tp: 0, fp: 0, fn: 0 };
  const issues: PRF = { tp: 0, fp: 0, fn: 0 };
  const billRefs: PRF = { tp: 0, fp: 0, fn: 0 };
  const actions: PRF = { tp: 0, fp: 0, fn: 0 };
  let resolutionCorrect = 0;
  let resolutionTotal = 0;
  let billAuto = 0;
  let billAutoCorrect = 0;
  let goldResolved = 0;
  let posTotal = 0;
  let posCorrect = 0;
  let posAuto = 0;
  let posAutoCorrect = 0;
  const perClass: Record<string, PRF> = {};
  const results: CaseResult[] = [];

  for (const c of cases) {
    const { result: r } = await runPipeline(
      {
        envelope: { fromAddress: c.from ?? "resident@mail.example", fromName: "Resident", subject: c.subject, headers: c.headers ?? {}, labels: [],
          direction: "inbound", sentAt: new Date(c.sentAt ?? EVAL_DEFAULT_SENT_AT) },
        bodyText: c.body,
        bodyHtml: null,
      },
      EVAL_DEPS,
    );
    const errors: string[] = [];
    const predTypes = r.message_type.filter((t) => t.confidence >= 0.5).map((t) => t.type);
    add(types, predTypes as string[], c.gold.types);
    if (predTypes.join() !== [...c.gold.types].join() && !c.gold.types.every((t) => (predTypes as string[]).includes(t))) {
      errors.push(`types ${predTypes.join("+")} vs ${c.gold.types.join("+")}`);
    }

    const predIssues = r.issues.map((i) => i.taxonomy_id).filter((k) => k.includes("."));
    add(issues, predIssues, c.gold.issues);
    for (const k of predIssues) if (!c.gold.issues.includes(k)) errors.push(`extra issue ${k}`);
    for (const k of c.gold.issues) if (!predIssues.includes(k)) errors.push(`missed issue ${k}`);

    add(billRefs, r.bill_references.map((b) => b.reference), c.gold.bills.map((b) => b.ref));
    for (const g of c.gold.bills) {
      if (g.resolution === "resolved") goldResolved++;
      const p = r.bill_references.find((b) => b.reference === g.ref);
      if (!p) {
        errors.push(`missed bill ${g.ref}`);
        continue;
      }
      resolutionTotal++;
      const auto = p.resolution_status === "resolved" && p.confidence >= EVAL_DEPS.thresholds.billMatch && p.bill_id;
      const correctBill = g.resolution === "resolved" ? p.bill_id !== null && keyForId.get(p.bill_id) === g.bill : p.bill_id === null
        || p.resolution_status !== "resolved";
      if (p.resolution_status === g.resolution && correctBill) resolutionCorrect++;
      else errors.push(`bill ${g.ref} ${p.resolution_status}(${p.confidence}) vs ${g.resolution}`);
      if (auto) {
        billAuto++;
        if (g.resolution === "resolved" && keyForId.get(p.bill_id!) === g.bill) billAutoCorrect++;
      }
    }
    for (const p of r.bill_references) {
      if (!c.gold.bills.some((g) => g.ref === p.reference) && p.resolution_status === "resolved" && p.confidence >= 0.95) billAuto++; // spurious auto-link
    }

    const predPos = r.positions.map((p) => ({ target: p.target_type === "bill" ? `bill:${p.bill_reference}` : `issue:${p.issue_id}`, position: p.position,
      confidence: p.confidence, type: p.target_type }));
    const hasBills = r.bill_references.length > 0;
    for (const p of predPos) {
      const auto = p.type === "bill" ? ["support", "oppose", "neutral"].includes(p.position) && p.confidence >= EVAL_DEPS.thresholds.position
        : ["support", "oppose"].includes(p.position) && p.confidence >= EVAL_DEPS.thresholds.position && !hasBills;
      if (!auto) continue;
      posAuto++;
      const g = c.gold.positions.find((x) => x.target === p.target);
      if (g && g.position === p.position) posAutoCorrect++;
      else errors.push(`auto-accepted position ${p.target}=${p.position} (${p.confidence}) but gold ${g?.position ?? "none"}`);
    }
    for (const g of c.gold.positions) {
      posTotal++;
      const p = predPos.find((x) => x.target === g.target);
      const pred = p?.position ?? "none";
      perClass[g.position] ??= { tp: 0, fp: 0, fn: 0 };
      if (pred === g.position) {
        posCorrect++;
        perClass[g.position].tp++;
      } else {
        perClass[g.position].fn++;
        if (pred !== "none") (perClass[pred] ??= { tp: 0, fp: 0, fn: 0 }).fp++;
        errors.push(`position ${g.target} ${pred} vs ${g.position}`);
      }
    }
    const predActions = r.requested_actions.filter((a) => a !== "none");
    add(actions, predActions, c.gold.actions);
    results.push({ c, r, errors });
  }
  return {
    split,
    n: cases.length,
    types: prf(types),
    issues: prf(issues),
    billExtraction: prf(billRefs),
    billResolutionAccuracy: resolutionTotal ? resolutionCorrect / resolutionTotal : 1,
    billAutoPrecision: billAuto ? billAutoCorrect / billAuto : 1,
    billAutoCoverage: goldResolved ? billAutoCorrect / goldResolved : 1,
    billAuto,
    positionAccuracy: posTotal ? posCorrect / posTotal : 1,
    positionAutoPrecision: posAuto ? posAutoCorrect / posAuto : 1,
    positionAuto: posAuto,
    positionAutoCoverage: posTotal ? posAutoCorrect / posTotal : 1,
    positionsPerClass: Object.fromEntries(Object.entries(perClass).map(([k, v]) => [k, prf(v)])),
    actions: prf(actions),
    results,
  };
}
