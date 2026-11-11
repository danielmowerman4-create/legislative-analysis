import type { ActionClass, BillStatus } from "../db/schema";

const TYPE_MAP: Record<string, string> = {
  HB: "HB", SB: "SB", HR: "HR", SR: "SR", HJR: "HJR", SJR: "SJR", AB: "AB", LB: "LB", HF: "HF", SF: "SF",
  "HOUSE BILL": "HB", "SENATE BILL": "SB", "HOUSE RESOLUTION": "HR", "SENATE RESOLUTION": "SR",
  "HOUSE JOINT RESOLUTION": "HJR", "SENATE JOINT RESOLUTION": "SJR", "ASSEMBLY BILL": "AB",
};

export function normalizeBillType(raw: string) {
  return TYPE_MAP[raw.replace(/[.\s]/g, "").toUpperCase()] ?? TYPE_MAP[raw.replace(/\s+/g, " ").toUpperCase()] ?? raw.replace(/[.\s]/g, "").toUpperCase();
}

export function normalizeBillIdentifier(type: string, number: number | string) {
  return `${normalizeBillType(type)} ${Number(number)}`;
}

// "HB142", "H.B. 142" and "HB 142" all parse to HB 142.
export function parseBillNumber(raw: string): { identifier: string; billType: string; number: number } | null {
  const m = raw.replace(/\s+/g, " ").trim().match(/^([A-Za-z.\s]+?)\s*0*(\d+)$/);
  if (!m) return null;
  const identifier = normalizeBillIdentifier(m[1], m[2]);
  const [billType] = identifier.split(" ");
  return { identifier, billType, number: Number(m[2]) };
}

// LegiScan writes "0000-00-00" for an unknown date.
export function validDate(d: string | null | undefined): string | null {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== "0000-00-00" ? d : null;
}

// A wall-clock time in the given zone as a UTC ISO string; local noon if no usable time.
export function localTimeToIso(date: string, time: string | null | undefined, timeZone: string): string | null {
  const day = validDate(date);
  if (!day) return null;
  const [y, mo, d] = day.split("-").map(Number);
  const t = time?.match(/^(\d{1,2}):(\d{2})/);
  const h = t && Number(t[1]) < 24 ? Number(t[1]) : 12;
  const mi = t ? Number(t[2]) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const offset = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  // Two passes, so the offset is the one in effect at the event (DST).
  const first = wall - offset(wall);
  return new Date(wall - offset(first)).toISOString();
}

export function chamberOf(billType: string): "upper" | "lower" | "joint" {
  if (/^(S|SB|SR|SJR|SCR|SF)$/i.test(billType)) return "upper";
  if (/^(H|HB|HR|HJR|HCR|HF|AB|A)$/i.test(billType)) return "lower";
  return "joint";
}

const RULES: [ActionClass, RegExp][] = [
  ["vetoed", /\bveto(ed)?\b/i],
  ["signed", /\b(signed by (the )?governor|approved by (the )?governor|act\s+\d+|chaptered|became law|enacted|effective date)\b/i],
  ["failed", /\b(failed|lost|tabled|died|defeated|indefinitely postponed|withdrawn)\b/i],
  ["hearing_scheduled", /\b(hearing (scheduled|set)|set for hearing|scheduled for (hearing|committee))\b/i],
  ["amendment", /\bamend(ment|ed)\b|\bsubstitute\b/i],
  ["passed", /\b(passed|adopted|third reading passed|agreed to)\b/i],
  ["chamber_vote", /\b(third reading|second reading|roll call|yeas?\b.*nays?|\(\d+-\d+\))/i],
  ["committee_action", /\b(favorabl[ey]|do pass|reported|committee (report|substitute)|hearing held|report pass|report dnp)\b/i],
  ["referred", /\b(referred to|re-?referred|assigned to)\b/i],
  ["introduced", /\b(introduced|first reading|prefiled|read first time|filed)\b/i],
];

export function classifyAction(description: string): ActionClass[] {
  let out = RULES.filter(([, re]) => re.test(description)).map(([k]) => k);
  // "Committee substitute adopted" is committee work, not passage of the bill.
  if (out.includes("passed") && /\b(committee|substitute|amendment)\b/i.test(description) && !/\b(third reading|passed)\b/i.test(description)) {
    out = out.filter((k) => k !== "passed");
  }
  return out.length ? out : ["other"];
}

const OS_MAP: Record<string, ActionClass> = {
  introduction: "introduced", filing: "introduced", "reading-1": "introduced", "referral-committee": "referred", referral: "referred",
  "committee-passage": "committee_action", "committee-passage-favorable": "committee_action", "committee-passage-unfavorable": "committee_action",
  "committee-failure": "failed", "amendment-introduction": "amendment", "amendment-passage": "amendment", "amendment-failure": "amendment",
  "reading-2": "chamber_vote", "reading-3": "chamber_vote", passage: "passed", failure: "failed", withdrawal: "failed",
  "executive-signature": "signed", "became-law": "signed", "executive-veto": "vetoed", "veto-override-passage": "passed",
};

export function mapOpenStatesClassification(cls: string[], description: string): ActionClass[] {
  const mapped = [...new Set(cls.map((c) => OS_MAP[c]).filter((x): x is ActionClass => Boolean(x)))];
  return mapped.length ? mapped : classifyAction(description);
}

const LEGISCAN_STATUS: Record<number, BillStatus> = { 2: "passed_chamber", 3: "passed_both", 4: "enacted", 5: "vetoed", 6: "failed" };

export function legiscanStatus(code: number, hasReferral: boolean): BillStatus {
  if (code === 1) return hasReferral ? "in_committee" : "introduced";
  return LEGISCAN_STATUS[code] ?? "introduced";
}

export function statusFromActions(actions: { classification: string[]; chamber: string | null; description?: string }[]): BillStatus {
  let status: BillStatus = "introduced";
  const passedChambers = new Set<string>();
  for (const a of actions) {
    const c = a.classification;
    if (c.includes("signed")) status = "enacted";
    else if (status === "passed_both" && /\b(sent|transmitted|delivered) to (the )?governor\b/i.test(a.description ?? "")) status = "sent_to_executive";
    else if (c.includes("vetoed")) status = "vetoed";
    else if (c.includes("failed")) status = "failed";
    else if (c.includes("passed")) {
      passedChambers.add(a.chamber ?? `c${passedChambers.size}`);
      status = passedChambers.size >= 2 ? "passed_both" : "passed_chamber";
    } else if ((c.includes("referred") || c.includes("committee_action")) && status === "introduced") status = "in_committee";
  }
  return status;
}

export const STATUS_LABEL: Record<BillStatus, string> = {
  introduced: "Introduced", in_committee: "In committee", passed_chamber: "Passed one chamber", passed_both: "Passed both chambers",
  sent_to_executive: "Sent to governor", enacted: "Enacted", vetoed: "Vetoed", failed: "Did not pass", withdrawn: "Withdrawn", other: "Other",
};
