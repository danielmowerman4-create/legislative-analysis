import type { ActionClass, BillStatus } from "../db/schema";

export const CT_SESSION = {
  providerId: "ct-2026", identifier: "2026", name: "2026 Regular Session", startDate: "2026-02-04", endDate: "2026-05-06", isSpecial: false,
};

export const CT_BASE = "https://www.cga.ct.gov";
export const ctStatusUrl = (billNum: string) => `${CT_BASE}/asp/cgabillstatus/cgabillstatus.asp?selBillType=Bill&bill_num=${billNum}&which_year=2026`;

type Chamber = "lower" | "upper";
export const CT_CHAMBER_FOR_TYPE = (t: string): Chamber => (t.startsWith("H") ? "lower" : "upper");

export const squeeze = (s: string) => s.replace(/\s+/g, " ").trim();
export const joinWrapped = (a: string, b: string) => (a.endsWith("-") ? `${a}${b}` : `${a} ${b}`);

type Translated = { description: string; chamber: Chamber | null; classification: ActionClass[] };
type CommitteeName = (code: string) => string;
type Rule = [RegExp, (q1: string, q2: string, committee: CommitteeName, previous: Chamber | null) => Translated];

const H = "lower" as const;
const S = "upper" as const;
const act = (description: string, chamber: Chamber | null, classification: ActionClass[] = ["other"]): Translated => ({ description, chamber, classification });

function list(items: string[]) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function amendments(house: "House" | "Senate", q: string) {
  const letters = q.split(",").map((s) => s.trim()).filter(Boolean);
  return `${house} ${letters.length > 1 ? "Amendments" : "Amendment"} ${list(letters)}`;
}

const lco = (q: string) => (q ? ` (LCO ${q})` : "");

function hearingDay(mmdd: string) {
  const m = Number(mmdd.slice(0, 2));
  const d = Number(mmdd.slice(2, 4));
  const name = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1];
  return name && d ? `${name} ${d}` : mmdd;
}

const PASSED: ActionClass[] = ["chamber_vote", "passed"];
const REFERRED: ActionClass[] = ["referred"];
const COMMITTEE: ActionClass[] = ["committee_action"];
const AMENDMENT: ActionClass[] = ["amendment"];
const SENT_ON: ActionClass[] = ["committee_action", "referred"];

// The first match wins, so longer phrases come before the phrases they start with.
const RULES: Rule[] = [
  [/^REF\. TO JOINT COMM\. ON/, (q, _, c) => act(`Referred to ${c(q)}`, null, REFERRED)],
  [/^REF\. BY HOUSE TO COMMITTEE ON/, (q, _, c) => act(`House referred to ${c(q)}`, H, REFERRED)],
  [/^REF\. BY SEN\. TO COMM\. ON/, (q, _, c) => act(`Senate referred to ${c(q)}`, S, REFERRED)],
  [/^IMMEDIATE TRANSMITTAL TO COMM\. ON/, (q, _, c) => act(`Sent directly to ${c(q)}`, null, REFERRED)],
  [/^IMMEDIATE TRANSMITTAL TO COMMITTEE/, () => act("Sent directly to committee", null, REFERRED)],
  [/^IMMEDIATE TRANSMITTAL TO THE SENATE/, () => act("Sent directly to the Senate", H)],
  [/^IMMEDIATE TRANSMITTAL TO THE HOUSE/, () => act("Sent directly to the House", S)],
  [/^IMMEDIATE TRANSMITTAL TO THE GOV/, () => act("Sent directly to the Governor", null)],
  [/^NOMINATION REFERRED TO COMMITTEE ON/, (q, _, c) => act(`Nomination referred to ${c(q)}`, null, REFERRED)],
  [/^RESERVED FOR SUBJECT MATTER PUBLIC HEARING/, () => act("Reserved for a subject matter public hearing", null)],
  [/^PUBLIC HEARING/, (q) => act(`Public hearing ${hearingDay(q)}`, null, ["hearing_scheduled"])],
  [/^FILED WITH LCO/, () => act("Sent to the Legislative Commissioners' Office", null)],
  [/^RPTD\. OUT OF LCO/, () => act("Reported out of the Legislative Commissioners' Office", null)],
  [/^REFERRED TO OLR, OFA/, () => act("Sent to the Office of Legislative Research and the Office of Fiscal Analysis", null)],
  [/^JOINT FAVORABLE SUBSTITUTE CHANGE OF REFERENCE/, (q, _, c) => act(`Committee voted Joint Favorable Substitute, sent to ${c(q)}`, null, SENT_ON)],
  [/^JOINT FAVORABLE CHANGE OF REFERENCE/, (q, _, c) => act(`Committee voted Joint Favorable, sent to ${c(q)}`, null, SENT_ON)],
  [/^JOINT FAVORABLE SUBSTITUTE/, () => act("Committee voted Joint Favorable Substitute", null, COMMITTEE)],
  [/^JOINT FAVORABLE/, () => act("Committee voted Joint Favorable", null, COMMITTEE)],
  [/^FAV\. RPT\., TABLED FOR HOUSE CALENDAR/, () => act("Favorable report, tabled for the House calendar", H, COMMITTEE)],
  [/^FAV\. RPT\., TAB\. FOR CAL\., SEN\./, () => act("Favorable report, tabled for the Senate calendar", S, COMMITTEE)],
  [/^TABLED FOR HOUSE CALENDAR/, () => act("Tabled for the House calendar", H)],
  [/^HOUSE CALENDAR NUMBER/, (q) => act(`House Calendar No. ${q}`, H)],
  [/^SENATE CALENDAR NUMBER/, (q) => act(`Senate Calendar No. ${q}`, S)],
  [/^FILE NO\./, (q) => act(`Printed as File No. ${q}`, null)],
  [/^NO NEW FILE BY COMM\. ON/, (q, _, c) => act(`No new file from ${c(q)}`, null)],
  [/^NEW FILE BY COMM\. ON/, (q, _, c) => act(`New file from ${c(q)}`, null)],
  [/^FAV\. CHG\. OF REF\. HOUSE TO COMM\. ON/, (q, _, c) => act(`House favorable change of reference to ${c(q)}`, H, REFERRED)],
  [/^FAV\. CHG\. OF REF\., SEN\. TO COMM\. ON/, (q, _, c) => act(`Senate favorable change of reference to ${c(q)}`, S, REFERRED)],
  [/^CHG\. REF\., HOUSE TO COMM\. ON/, (q, _, c) => act(`House changed the reference to ${c(q)}`, H, REFERRED)],
  [/^CHG\. REF\., SEN\. TO COMM\. ON/, (q, _, c) => act(`Senate changed the reference to ${c(q)}`, S, REFERRED)],
  [/^CHANGE OF REFERENCE/, (q, _, c) => act(`Reference changed to ${c(q)}`, null, REFERRED)],
  [/^FAV\. RPT\. HOUSE COMM\. ON/, (q, _, c) => act(`Favorable report from ${c(q)}`, H, COMMITTEE)],
  [/^HOUSE FAVORABLE/, () => act("Favorable report in the House", H, COMMITTEE)],
  [/^SENATE FAVORABLE/, () => act("Favorable report in the Senate", S, COMMITTEE)],
  [/^VOTE TO DRAFT/, () => act("Committee voted to draft", null, COMMITTEE)],
  [/^DRAFTED BY COMMITTEE/, () => act("Drafted by committee", null)],
  [/^MOTION FAILED/, (q) => act(q.toUpperCase() === "JF" ? "Committee motion for Joint Favorable failed" : "Committee motion failed", null, COMMITTEE)],
  [/^HOUSE PASSED, HOUSE AMEND/, (q) => act(`House passed as amended by ${amendments("House", q)}`, H, PASSED)],
  [/^HOUSE PASSED, SEN\. AMEND/, (q) => act(`House passed as amended by ${amendments("Senate", q)}`, H, PASSED)],
  [/^HOUSE PASSED/, () => act("House passed", H, PASSED)],
  [/^SEN\. PASSED, HO\. AMEND/, (q) => act(`Senate passed as amended by ${amendments("House", q)}`, S, PASSED)],
  [/^SEN\. PASSED, SEN\. AMEND/, (q) => act(`Senate passed as amended by ${amendments("Senate", q)}`, S, PASSED)],
  [/^SENATE PASSED/, () => act("Senate passed", S, PASSED)],
  [/^ADOPTED, HOUSE/, () => act("Adopted by the House", H, PASSED)],
  [/^ADOPTED, SENATE/, () => act("Adopted by the Senate", S, PASSED)],
  [/^HOUSE ADOPTED HOUSE AMEND/, (q, l) => act(`House adopted ${amendments("House", q)}${lco(l)}`, H, AMENDMENT)],
  [/^HOUSE ADOPTED SEN\. AMEND/, (q, l) => act(`House adopted ${amendments("Senate", q)}${lco(l)}`, H, AMENDMENT)],
  [/^HOUSE REJECTED HOUSE AMEND/, (q, l) => act(`House rejected ${amendments("House", q)}${lco(l)}`, H, AMENDMENT)],
  [/^HOUSE DESIGNATED HO\. AMEND/, (q, l) => act(`House designated ${amendments("House", q)}${lco(l)}`, H, AMENDMENT)],
  [/^SEN\. ADOPTED SEN\. AMEND/, (q, l) => act(`Senate adopted ${amendments("Senate", q)}${lco(l)}`, S, AMENDMENT)],
  [/^SEN\. ADOPTED HO\. AMEND/, (q, l) => act(`Senate adopted ${amendments("House", q)}${lco(l)}`, S, AMENDMENT)],
  [/^SEN\. REJ\. SEN\. AMEND/, (q, l) => act(`Senate rejected ${amendments("Senate", q)}${lco(l)}`, S, AMENDMENT)],
  [/^AMENDMENT WITHDRAWN HOUSE AMEND/, (q, l) => act(`${amendments("House", q)} withdrawn${lco(l)}`, H, AMENDMENT)],
  [/^AMENDMENT WITHDRAWN, SENATE AMENDMENT/, (q, l) => act(`${amendments("Senate", q)} withdrawn${lco(l)}`, S, AMENDMENT)],
  [/^ON CONSENT CALENDAR \/IN CONCURRENCE/, (_q, _l, _c, p) => act("On the consent calendar, in concurrence", p)],
  [/^ON CONSENT CALENDAR/, (_q, _l, _c, p) => act("On the consent calendar", p)],
  [/^IN CONCURRENCE/, (_q, _l, _c, p) => act("In concurrence with the other chamber", p)],
  [/^BILL PASSED TEMPORARILY/, (_q, _l, _c, p) => act("Passed temporarily (set aside on the floor)", p)],
  [/^MATTER PASS RETAINED/, (_q, _l, _c, p) => act("Passed retaining its place on the calendar", p)],
  [/^RULES SUSPENDED, ?TRANS\. ?TO HOUSE/, () => act("Rules suspended, sent to the House", S)],
  [/^RULES SUSPENDED, TRANSMITTED TO THE GOVERNOR/, () => act("Rules suspended, sent to the Governor", null)],
  [/^RULES SUSPENDED/, (_q, _l, _c, p) => act("Rules suspended", p)],
  [/^TRANSMITTED PURSUANT TO JOINT RULE/, (_q, _l, _c, p) => act("Sent to the other chamber under the joint rules", p)],
  [/^TRANSMITTED TO SECRETARY OF THE STATE/, () => act("Sent to the Secretary of the State", null)],
  [/^TRANSMITTED BY SECRETARY OF THE STATE TO GOVERNOR/, () => act("Sent to the Governor", null)],
  [/^SIGNED BY GOVERNOR IN ORIGINAL/, () => act("Signed by the Governor in the original", null, ["signed"])],
  [/^SIGNED BY GOVERNOR/, () => act("Signed by the Governor", null, ["signed"])],
  [/^LINE ITEM VETOED BY THE GOVERNOR/, (_q, l) => act(`Governor vetoed line items in sections ${l.split(",").map((x) => x.trim()).join(", ")}`, null)],
  [/^PUBLIC ACT/, (q) => act(`Public Act ${q}`, null)],
  [/^SPECIAL ACT/, (q) => act(`Special Act ${q}`, null)],
  [/^EMERGENCY CERTIFICATION/, () => act("Emergency certification", null)],
  [/^FILED WITH SENATE CLERKS/, () => act("Filed with the Senate Clerk", S)],
  [/^FILED WITH THE OFFICE OF THE HOUSE CLERK/, () => act("Filed with the House Clerk", H)],
  [/^MOVED TO FOOT OF CAL\., SENATE/, () => act("Moved to the foot of the Senate calendar", S)],
  [/^REMOVED FOOT OF CALENDAR SENATE/, () => act("Removed from the foot of the Senate calendar", S)],
  [/^POTENTIAL DISAGREEING ACTION, TABLED CAL\. HO\./, () => act("Potential disagreeing action, tabled for the House calendar", H)],
  [/^DISAGREEING ACTION, ?TABLED FOR CAL\., SEN\./, () => act("Disagreeing action, tabled for the Senate calendar", S)],
  [/^SEN\. RECOMMITTED TO/, (q, _, c) => act(`Senate recommitted to ${c(q)}`, S, REFERRED)],
  [/^SENATE RECONSIDERED/, () => act("Senate reconsidered", S)],
];

export function translateAction(raw: string, q1: string, q2: string, committee: CommitteeName, previous: Chamber | null): Translated & { known: boolean } {
  const phrase = squeeze(raw).toUpperCase();
  for (const [re, make] of RULES) if (re.test(phrase)) return { ...make(q1.trim(), q2.trim(), committee, previous), known: true };
  return { ...act(titleCase(phrase), previous), known: false };
}

const SMALL_WORDS = new Set("a an and as at but by for from in into nor of on or per than that the to upon via with".split(" "));
const ACRONYMS = new Set(
  "AFT AFSCME CEUI CDL CT CSCU DAS DCF DCP DECD DEEP DESPP DMHAS DMV DNA DOC DOT DPH DSS ECS EMS EMT ERISA EV EVS FOI GPS HIV HUD HUSKY II III IV LGBTQ LLC OPM PFAS PPA PTSD PURA RFID SEBAC SEIU SNAP STEM THC UAW USA VI VII WIC".split(" "),
);
function capitalizeWord(w: string) {
  const bare = w.replace(/[^A-Za-z]/g, "");
  if (ACRONYMS.has(bare)) return w;
  if (bare === "UCONN") return w.replace("UCONN", "UConn");
  return w
    .toLowerCase()
    .replace(/(^|[-(/])([a-z])/g, (_, before: string, c: string) => before + c.toUpperCase())
    .replace(/^([OD]')([a-z])/i, (_, before: string, c: string) => before.toUpperCase() + c.toUpperCase())
    .replace(/^Mc([a-z])/, (_, c: string) => `Mc${c.toUpperCase()}`);
}

export function titleCase(all: string) {
  const words = squeeze(all).replace(/\.$/, "").split(" ");
  return words.map((w, i) => (i > 0 && i < words.length - 1 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : capitalizeWord(w))).join(" ");
}

export type CtAction = Translated & { date: string; raw: string };

const isResolution = (type: string) => /^(HJ|SJ|HR|SR)$/.test(type);
const isSimple = (type: string) => /^(HR|SR)$/.test(type);

export function undoReconsidered<T extends Translated>(actions: T[]): T[] {
  return actions.map((a, i) => {
    if (!a.classification.includes("passed")) return a;
    const undone = actions.slice(i + 1).some((b) => b.chamber === a.chamber && /reconsidered$/.test(b.description));
    return undone ? { ...a, classification: a.classification.filter((c) => c !== "passed") } : a;
  });
}

type Outcome = { status: BillStatus; statusText: string; statusDate: string | null; dead: boolean };
const outcome = (status: BillStatus, statusText: string, statusDate: string | null): Outcome => ({ status, statusText, statusDate, dead: false });
const ended = (statusText: string): Outcome => ({ status: "failed", statusText, statusDate: CT_SESSION.endDate, dead: true });

// The session ended May 6, so a bill that had not cleared both chambers is dead.
export function ctOutcome(type: string, origin: Chamber, actions: CtAction[]): Outcome {
  const lastDate = actions.at(-1)?.date ?? null;
  const adoptedOn = actions.filter((a) => /^Adopted/.test(a.description)).at(-1)?.date ?? lastDate;
  const has = (c: ActionClass) => actions.some((a) => a.classification.includes(c));
  const publicAct = actions.find((a) => /^(Public|Special) Act /.test(a.description));
  const signed = actions.find((a) => a.classification.includes("signed"));
  if (publicAct || signed) {
    const name = publicAct?.description ?? "Signed by the Governor";
    const vetoedLines = actions.some((a) => /vetoed line items/.test(a.description));
    return outcome("enacted", vetoedLines ? `${name}, with a line-item veto` : name, signed?.date ?? publicAct?.date ?? lastDate);
  }
  const passed = (c: Chamber) => actions.some((a) => a.classification.includes("passed") && a.chamber === c);
  const passedLower = passed("lower");
  const passedUpper = passed("upper");
  if (isSimple(type)) return passed(origin) ? outcome("passed_chamber", "Adopted", adoptedOn) : ended("Not adopted");
  if (passedLower && passedUpper) {
    if (isResolution(type)) return outcome("passed_both", "Adopted", adoptedOn);
    return actions.some((a) => /to the Governor/.test(a.description))
      ? outcome("sent_to_executive", "Sent to the Governor", lastDate)
      : outcome("passed_both", "Passed both chambers", lastDate);
  }
  if (isResolution(type)) return ended("Not adopted");
  const reconsidered = actions.some((a) => /reconsidered$/.test(a.description));
  if (passedLower) return ended(reconsidered ? "Passed the House, Senate vote reconsidered" : "Passed the House, no Senate vote");
  if (passedUpper) return ended(reconsidered ? "Passed the Senate, House vote reconsidered" : "Passed the Senate, no House vote");
  if (actions.some((a) => /Calendar No\./.test(a.description))) return ended("On the calendar, no floor vote");
  if (has("committee_action")) return ended("Reported by committee, no floor vote");
  return ended(has("hearing_scheduled") ? "Public hearing, no committee vote" : "No committee action");
}

// Page furniture: line numbers, "sHB5001 / File No. 725 1", "LCO 3456  1 of 5".
const FURNITURE = [
  /^\d{1,4}$/, /^s?[HS][BJR]\d+(\s*\/\s*File No\. ?\d+)?(\s+\d+)?$/i, /^File No\. ?\d+$/i, /^LCO( No\.)? ?\{?[\w.\\-]*\}?(\s+\d+ of \d+)?$/i, /^\d+ of \d+$/,
];
const BLOCK_START = [/^(Sec\.|Section) \d+[A-Za-z]?\.( |$)/, /^\[?\(([a-z]|[0-9]{1,2}|[A-Z])\)/, /^Statement of Purpose:/, /^Be it enacted/];

// Extracted lines end in their line number ("the1"); strip it only in sequence.
function stripLineNumbers(lines: string[]) {
  let probe = 1;
  for (const l of lines.slice(0, 60)) if (l.endsWith(String(probe))) probe++;
  if (probe < 4) return lines;
  let next = 1;
  return lines.map((l) => {
    for (let n = next; n <= next + 4; n++) {
      const s = String(n);
      // Catching up after a gap needs a clean break, so a citation is not eaten.
      if (l.length > s.length && l.endsWith(s) && (n === next || !/\d/.test(l[l.length - s.length - 1]))) {
        next = n + 1;
        return l.slice(0, -s.length).trimEnd();
      }
    }
    return l;
  });
}

export function cleanBillText(raw: string) {
  const lines = stripLineNumbers(raw.replace(/\r\n?/g, "\n").split("\n").map(squeeze).filter((l) => l && !FURNITURE.some((re) => re.test(l))));
  const seen = new Map<string, number>();
  for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
  const firstKept = new Set<string>();
  const out: string[] = [];
  let breakNext = false;
  for (const l of lines) {
    if ((seen.get(l) ?? 0) >= 3 && l.length < 70 && /Bill No\.|Public Act No\.|Special Act No\./i.test(l)) {
      if (firstKept.has(l)) continue;
      firstKept.add(l);
    }
    if (!out.length || breakNext || BLOCK_START.some((re) => re.test(l))) out.push(l);
    else out[out.length - 1] += ` ${l}`;
    breakNext = /convened:$/.test(l);
  }
  return out.join("\n\n").trim();
}
