// robots.txt closes /asp/cgabillstatus/, so bill status pages are never fetched.
import { createHash } from "node:crypto";
import {
  CT_BASE, CT_CHAMBER_FOR_TYPE, CT_SESSION, cleanBillText, ctOutcome, ctStatusUrl, titleCase, translateAction, undoReconsidered, type CtAction,
} from "./connecticut";
import { documentNames, parseAnalysis } from "./connecticut-analysis";
import { fetchFromCga, pdfToLayoutText, pdfToXml } from "./connecticut-fetch";
import { parseFiscalNote } from "./connecticut-fiscal";
import {
  countMarks, floorAddsUp, nameFloorVotes, parseFloorVote, parseTally, tallyAddsUp, type FloorVote, type MemberMark, type TallyVote,
} from "./connecticut-votes";
import { extractCodeSections } from "./related";
import { extractDocumentText } from "./text";
import type { CommitteeRole, NormalizedBill, NormalizedPerson, NormalizedSession } from "./types";

const OFFICE_DISTRICT = "119";
const MIN_GAP_MS = 300;
const RECHECK_MISSES_MS = 7 * 86400_000;

export const CT_FILES = ["bill_info", "bill_history", "introducer", "subject", "committee", "LegislatorDatabase"] as const;
export const CT_VOTE_FOLDERS = [
  { ftp: "vote/h/pdf", web: "VOTE/H/PDF" },
  { ftp: "vote/s/pdf", web: "VOTE/S/PDF" },
  { ftp: "ts/h/pdf", web: "TS/H/PDF" },
  { ftp: "ts/s/pdf", web: "TS/S/PDF" },
];

type MemberVote = { name: string; providerPersonId: string | null; vote: "yes" | "no" | "not_voting" | "absent" };
export type CtSnapshot = {
  builtAt: string; sourceFilesDated: string; session: NormalizedSession; people: NormalizedPerson[]; bills: NormalizedBill[];
  versionTexts: Record<string, string>; rollCallVotes: Record<string, MemberVote[]>;
};

export type StoredDocument = { found: boolean; body: string | null; checkedAt: Date };
export type CtSource = {
  csv(name: (typeof CT_FILES)[number]): Promise<string>;
  listFolder(ftp: string): Promise<string[]>;
  read(url: string): Promise<StoredDocument | null>;
  write(url: string, found: boolean, body: string | null): Promise<void>;
};

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const groupBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
};

const fileNumbers = (versions: NormalizedBill["versions"]) => versions.flatMap((v) => v.label.match(/File No\.?\s*(\d+)/)?.[1] ?? []).map(Number);
const isPdf = (r: { ok: boolean; contentType: string }) => r.ok && /pdf/i.test(r.contentType);
const sheetUrl = (v: { web: string; file: string }) => `${CT_BASE}/2026/${v.web}/${v.file}`;
const FIRST_LABEL: Record<string, string> = { RB: "Raised Bill", PB: "Proposed Bill", GB: "Governor's Bill", CB: "Committee Bill" };

// Reread what was checked before the bill's last action; recheck misses for a week.
function stillGood(doc: StoredDocument, acted: string | null) {
  if (!acted) return true;
  const at = new Date(acted).getTime();
  return doc.checkedAt.getTime() >= (doc.found ? at : at + RECHECK_MISSES_MS);
}

export async function pdfToBillText(bytes: Uint8Array) {
  const raw = await extractDocumentText(bytes, "application/pdf");
  return raw ? cleanBillText(raw) : null;
}

export async function buildConnecticutSession(source: CtSource, opts: { limit?: number; onProgress?: (line: string) => void } = {}) {
  let lastStart = 0;
  let requests = 0;
  async function politeFetch(url: string, method: "GET" | "HEAD") {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    lastStart = Math.max(Date.now(), lastStart + MIN_GAP_MS);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchFromCga(url, method);
        // An outage must not read as a missing document.
        if (res.status >= 500 || res.status === 429) throw new Error(`${url}: ${res.status}`);
        requests++;
        return res;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
  }

  async function csv(name: (typeof CT_FILES)[number]) {
    const rows = parseCsv(await source.csv(name));
    // In January these files turn over to the next session; keep its bills out.
    return "sess_year" in (rows[0] ?? {}) ? rows.filter((r) => r.sess_year === CT_SESSION.identifier) : rows;
  }

  async function exists(url: string, acted: string | null) {
    const doc = await source.read(url);
    if (doc && stillGood(doc, acted)) return doc.found;
    const found = isPdf(await politeFetch(url, "HEAD"));
    await source.write(url, found, found ? (doc?.body ?? null) : null);
    return found;
  }

  async function bodyOf(url: string, acted: string | null, convert: (bytes: Uint8Array) => Promise<string | null>) {
    const doc = await source.read(url);
    if (doc && stillGood(doc, acted) && (!doc.found || doc.body !== null)) return doc.body;
    const res = await politeFetch(url, "GET");
    if (!isPdf(res)) {
      await source.write(url, false, null);
      return null;
    }
    const body = await convert(res.bytes);
    if (body !== null) await source.write(url, true, body);
    return body;
  }

  const analysisStats = { found: 0, none: 0 };
  async function analysisFor(billNum: string, versions: NormalizedBill["versions"], amended: boolean, acted: string | null) {
    for (const name of documentNames(billNum, fileNumbers(versions), amended, "BA")) {
      const url = `${CT_BASE}/2026/BA/PDF/${name}`;
      const text = await bodyOf(url, acted, pdfToLayoutText);
      const analysis = text && parseAnalysis(text);
      if (analysis) {
        analysisStats.found++;
        return { ...analysis, url };
      }
    }
    analysisStats.none++;
    return null;
  }

  const fiscalStats = { found: 0, none: 0, unread: [] as string[] };
  async function fiscalFor(billNum: string, versions: NormalizedBill["versions"], amended: boolean, acted: string | null) {
    for (const name of documentNames(billNum, fileNumbers(versions), amended, "FN")) {
      const url = `${CT_BASE}/2026/FN/PDF/${name}`;
      const xml = await bodyOf(url, acted, pdfToXml);
      if (!xml) continue;
      const note = parseFiscalNote(xml);
      if (note) {
        fiscalStats.found++;
        const file = name.match(/-R0\d(\d{4})-/)?.[1];
        return { ...note, describes: note.describes ?? (file ? `File ${Number(file)}` : null), url };
      }
      fiscalStats.unread.push(name);
    }
    fiscalStats.none++;
    return null;
  }

  async function fetchVotes() {
    const out: { name: string; web: string; text: string }[] = [];
    for (const f of CT_VOTE_FOLDERS) {
      for (const name of await source.listFolder(f.ftp)) {
        const text = await bodyOf(`${CT_BASE}/2026/${f.web}/${name}`, null, pdfToLayoutText);
        if (text === null) throw new Error(`${name}: listed by the state but not there`);
        out.push({ name, web: f.web, text });
      }
    }
    return out;
  }

  const problems: string[] = [];
  const [info, history, introducers, subjects, committeeRows, people] = await Promise.all(CT_FILES.map(csv));
  if (!info.length) throw new Error(`The state's bill file holds no ${CT_SESSION.identifier} bills`);

  const committeeName = new Map(committeeRows.map((c) => [c.comm_code, c.comm_name]));
  committeeName.set("GOV", "Governor");
  const committee = (code: string) => committeeName.get(code) ?? code;
  const shortName = (name: string) => name.replace(/^Joint Committee on /, "").replace(/ Committee$/, "");
  const codeForName = new Map(committeeRows.map((c) => [shortName(c.comm_name), c.comm_code]));

  const unknownPhrases = new Map<string, number>();
  const roster: (NormalizedPerson & { code: string })[] = people.map((p) => {
    const chamber = p["office code"] === "S" ? ("upper" as const) : ("lower" as const);
    const district = String(Number(p.dist));
    const roles: CommitteeRole[] = (p["committee member1"] ?? "").split(";").map((s) => s.trim()).filter(Boolean).map((entry) => {
      const m = entry.match(/^(.*?)(?: \((Chair|Vice Chair|Ranking Member)\))?$/)!;
      const code = codeForName.get(m[1]);
      return { committee: m[1], code: code ? `ct-${code}` : null, role: (m[2] ?? "Member") as CommitteeRole["role"] };
    });
    const first = p["commonly used name"] || p["first name"];
    const suffix = p.suffix ? ` ${p.suffix}` : "";
    return {
      code: chamber === "upper" ? `S${p.dist.padStart(2, "0").slice(-2)}` : p.dist.padStart(3, "0"),
      providerPersonId: `ct-${chamber === "upper" ? "s" : "h"}${district}`, name: `${first} ${p["last name"]}${suffix}`,
      party: p.party.startsWith("R") ? "R" : p.party.startsWith("D") ? "D" : p.party || null, chamber, district, committeeRoles: roles, title: p.title || null,
      // Official details only: the file's home addresses and phones are never read.
      contact: {
        ...(p.email ? { email: p.email } : {}), ...(p["capitol phone"] ? { phone: p["capitol phone"] } : {}),
        ...(p["room number"] ? { office: [p["capitol street address"], `Room ${p["room number"]}`].filter(Boolean).join(", ") } : {}),
      },
    };
  });
  const personByCode = new Map(roster.map((p) => [p.code, p]));

  // Sheets name House members by surname (plus initial) and senators by district.
  const plain = (s: string) => s.toUpperCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
  const houseBySurname = groupBy(people.filter((p) => p["office code"] !== "S"), (p) => plain(p["last name"]));
  const personFor = (p: Record<string, string>) => personByCode.get(p.dist.padStart(3, "0"));
  const unmatched = new Map<string, number>();
  const miss = (name: string) => unmatched.set(name, (unmatched.get(name) ?? 0) + 1);
  const houseMember = (printed: string) => {
    const [surname, initial] = printed.split(",").map((x) => x.trim());
    const found = houseBySurname.get(plain(surname)) ?? houseBySurname.get(plain(surname).replace(/ (JR|SR|II|III)$/, "")) ?? [];
    const firsts = (p: Record<string, string>) => [plain(p["commonly used name"] || p["first name"]), plain(p["first name"])];
    const pick = found.length > 1 && initial ? found.filter((p) => firsts(p).some((n) => n.startsWith(plain(initial)))) : found;
    return pick.length === 1 ? personFor(pick[0]) : null;
  };
  const seatedMember = (m: MemberMark, surnameLast: boolean) => {
    const seat = m.district!;
    const p = seat.startsWith("S") ? personByCode.get(`S${seat.slice(1).padStart(2, "0")}`) : personByCode.get(seat.padStart(3, "0"));
    if (!p) return null;
    // A seat can change hands mid-session: the sheet's name must match the holder.
    const printed = plain(m.name ?? "");
    const held = plain(p.name.replace(/ (Jr\.?|Sr\.?|II|III)$/, "")).split(" ").at(-1)!;
    return (surnameLast ? printed.endsWith(held) : printed.startsWith(held) || printed.includes(` ${held}`)) ? p : null;
  };
  const toMemberVote = (m: MemberMark, floorChamber: "lower" | "upper" | null) => {
    const upper = floorChamber === "upper";
    const p = floorChamber === "lower" ? houseMember(m.name!) : seatedMember(upper ? { ...m, district: `S${m.district}` } : m, upper);
    if (!p) miss(`${floorChamber ?? "committee"}: ${m.name ?? m.district}`);
    return { name: p?.name ?? titleCase(m.name ?? `Seat ${m.district}`), providerPersonId: p?.providerPersonId ?? null, vote: m.mark };
  };

  const voteFiles = await fetchVotes();
  const floorByBill = new Map<string, (FloorVote & { file: string; web: string })[]>();
  const tallyByBill = new Map<string, (TallyVote & { file: string; web: string })[]>();
  const voteStats = { floor: 0, floorBadParse: 0, floorOff: 0, tally: 0, tallyBadParse: 0, tallyOff: 0, motionMatched: 0, motionOpen: 0, noBill: 0 };
  const voteProblems: string[] = [];
  for (const f of voteFiles) {
    if (/-CV\d+-TS/i.test(f.name)) {
      const v = parseTally(f.text, f.name);
      if (!v) {
        voteStats.tallyBadParse++;
        voteProblems.push(`unreadable tally ${f.name}`);
        continue;
      }
      voteStats.tally++;
      if (!tallyAddsUp(v)) {
        voteStats.tallyOff++;
        voteProblems.push(`tally off ${f.name}: sheet ${v.yes}-${v.no}, read ${countMarks(v.members, "yes")}-${countMarks(v.members, "no")}`);
      }
      tallyByBill.set(v.billNum, [...(tallyByBill.get(v.billNum) ?? []), { ...v, file: f.name, web: f.web }]);
    } else {
      const v = parseFloorVote(f.text, f.name);
      if (!v) {
        voteStats.floorBadParse++;
        voteProblems.push(`unreadable floor ${f.name}`);
        continue;
      }
      voteStats.floor++;
      if (!floorAddsUp(v)) {
        voteStats.floorOff++;
        const read = `${countMarks(v.members, "yes")}-${countMarks(v.members, "no")}-${countMarks(v.members, "not_voting", "absent")}`;
        voteProblems.push(`floor off ${f.name}: sheet ${v.yes}-${v.no}-${v.absent}, read ${read}`);
      }
      floorByBill.set(v.billNum, [...(floorByBill.get(v.billNum) ?? []), { ...v, file: f.name, web: f.web }]);
    }
  }
  const rollCallVotes: Record<string, ReturnType<typeof toMemberVote>[]> = {};

  const historyByBill = groupBy(history, (r) => r.bill_num);
  const introducersByBill = groupBy(introducers, (r) => r.bill_num);
  const subjectsByBill = groupBy(subjects, (r) => r.bill_num);
  const office = new Set(introducers.filter((r) => r.intro_code === OFFICE_DISTRICT.padStart(3, "0")).map((r) => r.bill_num));

  const limit = opts.limit ?? 0;
  const rows = limit ? [...info.filter((b) => office.has(b.bill_num)).slice(0, 3), ...info.slice(0, limit)] : info;
  const texts: Record<string, string> = {};
  const bills: NormalizedBill[] = [];
  const unknownSponsors = new Set<string>();
  let done = 0;

  for (const b of rows) {
    const billNum = b.bill_num;
    const type = billNum.slice(0, 2);
    const number = Number(billNum.slice(2));
    const origin = CT_CHAMBER_FOR_TYPE(type);
    const padded = billNum.slice(2);
    const ordered = [...(historyByBill.get(billNum) ?? [])].sort((x, y) => Number(x.sort_order) - Number(y.sort_order));

    let previous: "lower" | "upper" | null = null;
    let currentCommittee: string | null = null;
    const recorded: (CtAction & { key: string; committee: string | null; q1: string; q2: string })[] = [];
    const committees = new Map<string, string>();
    for (const r of ordered) {
      const date = r.act_date.slice(0, 10);
      const t = translateAction(r.act_desc, r.qual1, r.qual2, committee, previous);
      if (!t.known) unknownPhrases.set(r.act_desc, (unknownPhrases.get(r.act_desc) ?? 0) + 1);
      if (t.classification.includes("referred") && committeeName.has(r.qual1)) {
        currentCommittee = r.qual1;
        if (!committees.has(r.qual1)) committees.set(r.qual1, date);
      }
      recorded.push({ ...t, date, raw: r.act_desc.toUpperCase(), key: r.sort_order, committee: currentCommittee, q1: r.qual1, q2: r.qual2 });
      if (t.chamber) previous = t.chamber;
    }
    const actions = undoReconsidered(recorded);

    const billVotes: NormalizedBill["votes"] = [];
    for (const chamber of ["lower", "upper"] as const) {
      const sheets = (floorByBill.get(billNum) ?? []).filter((v) => v.chamber === chamber).sort((a, b) => a.number - b.number);
      if (!sheets.length) continue;
      const names = nameFloorVotes(type, sheets, recorded);
      for (const v of sheets) {
        const id = `ct-${chamber === "lower" ? "HV" : "SV"}-${String(v.number).padStart(5, "0")}-${billNum}`;
        const named = names.get(v.number);
        if (named?.matched) voteStats.motionMatched++;
        else {
          voteStats.motionOpen++;
          voteProblems.push(`motion open ${v.file}: ${named?.motion ?? "none"} (${v.yes}-${v.no}, ${v.date})`);
        }
        const motion = named?.motion ?? `${chamber === "lower" ? "House" : "Senate"} procedural vote`;
        billVotes.push({
          providerRollCallId: id, date: v.date, chamber, motion, yes: v.yes, no: v.no, other: v.absent, passed: v.yes >= v.necessary, url: sheetUrl(v),
        });
        rollCallVotes[id] = v.members.map((m) => toMemberVote(m, chamber));
      }
    }
    const tallies = tallyByBill.get(billNum) ?? [];
    for (const [i, v] of tallies.entries()) {
      const code = committeeName.has(v.committee) ? v.committee : v.committee.slice(0, -1);
      // Two committees can number a sheet alike on one bill; the code keeps them apart.
      const repeated = tallies.slice(i + 1).some((t) => t.number === v.number);
      const id = `ct-CV-${String(v.number).padStart(5, "0")}-${billNum}${repeated ? `-${code}` : ""}`;
      const action = v.amendment ? `Amendment ${v.amendment}` : v.action === "MOTION FAILED" ? "Motion failed" : v.action || "Vote";
      billVotes.push({
        providerRollCallId: id, date: v.date, chamber: null, motion: `${committee(code)}: ${action}`, yes: v.yes, no: v.no,
        other: v.abstain + v.absent, passed: v.voice ? v.voice === "passed" : v.yes > v.no, url: sheetUrl(v),
      });
      rollCallVotes[id] = v.members.map((m) => toMemberVote(m, null));
    }

    const outcome = ctOutcome(type, origin, actions);
    const timeline = actions.map(({ key, date, chamber, description, classification }) => ({ providerKey: key, date, chamber, description, classification }));
    const adjourned = { providerKey: "session-end", date: CT_SESSION.endDate, chamber: null, description: "Session adjourned without final passage" };
    if (outcome.dead) timeline.push({ ...adjourned, classification: ["failed"] });
    // The adjournment line ends the timeline but is not the bill's last action.
    const last = actions.at(-1);
    const lastActed = last?.date ?? null;

    const prefix = `2026${type}-${padded}`;
    const chamberDir = origin === "upper" ? "S" : "H";
    const versions: NormalizedBill["versions"] = [];
    const amendmentsOut: NormalizedBill["amendments"] = [];
    let codeSections: string[] = [];

    if (type === "HB" || type === "SB") {
      const favorable = actions.filter((a) => /^JOINT FAVORABLE/.test(a.raw));
      const firstLabel = FIRST_LABEL[b.type_code] ?? "Bill as introduced";
      const candidates: NormalizedBill["versions"] = [];
      const pdf = (id: string, folder: string) => ({ providerVersionId: id, url: `${CT_BASE}/2026/${folder}/${id}.PDF`, mimeType: "application/pdf" });
      const tob = (n: number) => pdf(`${prefix}-R${String(n).padStart(2, "0")}-${type}`, `TOB/${chamberDir}/PDF`);
      const printed = actions.filter((a) => /^FILE NO\./.test(a.raw));
      const acted = actions.find((a) => /^(PUBLIC|SPECIAL) ACT/.test(a.raw));
      candidates.push({ ...tob(0), label: firstLabel, date: actions[0]?.date ?? null });
      for (const [i, a] of favorable.entries()) {
        const vote = /SUBSTITUTE/.test(a.raw) ? "Joint Favorable Substitute" : "Joint Favorable";
        candidates.push({ ...tob(i + 1), label: `${a.committee ?? "Committee"} ${vote}`, date: a.date });
      }
      for (const f of printed) candidates.push({ ...pdf(`${prefix}-R00${f.q1.padStart(4, "0")}-FC`, "FC/PDF"), label: `File No. ${f.q1}`, date: f.date });
      if (acted) {
        const kind = /^PUBLIC/.test(acted.raw) ? "PA" : "SA";
        const n = acted.q1.split("-")[1].padStart(5, "0");
        const label = `${kind === "PA" ? "Public" : "Special"} Act No. ${acted.q1}`;
        candidates.push({ ...pdf(`2026${kind}-${n}-R00${type}-${padded}-${kind}`, `ACT/${kind}/PDF`), label, date: acted.date });
      }
      // Newest first: the latest text is read whole, older ones only checked to exist.
      const newestFirst = [...candidates].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "") || candidates.indexOf(y) - candidates.indexOf(x));
      let latestText: string | null = null;
      for (const v of newestFirst) {
        const wantFull = latestText === null || office.has(billNum);
        if (wantFull) {
          const text = await bodyOf(v.url!, lastActed, pdfToBillText);
          if (text === null) continue;
          latestText ??= text;
          if (office.has(billNum)) texts[v.providerVersionId] = text;
          versions.unshift(v);
        } else if (await exists(v.url!, lastActed)) versions.unshift(v);
      }
      if (office.has(billNum) && !versions.length) problems.push(`No text found for ${billNum}`);
      codeSections = latestText ? extractCodeSections(latestText) : [];

      for (const a of actions.filter((x) => /^(HOUSE|SEN\.) (ADOPTED|REJECTED|REJ\.|DESIGNATED) (HOUSE|SEN\.|HO\.) AMEND/.test(x.raw))) {
        const owner = /^HOUSE/.test(a.raw) ? "H" : "S";
        const onOwn = owner === "H" ? /(HOUSE|HO\.) AMEND/.test(a.raw.replace(/^HOUSE \w+ /, "")) : /SEN\. AMEND/.test(a.raw.replace(/^SEN\. \w+\.? /, ""));
        if (!onOwn) continue;
        for (const letter of a.q1.split(",").map((s) => s.trim()).filter(Boolean)) {
          const url = `${CT_BASE}/2026/amd/${chamberDir}/pdf/${prefix}-R00${owner}${letter}-AMD.pdf`;
          const title = `${owner === "H" ? "House" : "Senate"} Amendment ${letter}${a.q2 ? ` (LCO ${a.q2})` : ""}`;
          amendmentsOut.push({
            providerAmendmentId: `${prefix}-${owner}${letter}`, title, description: null, chamber: owner === "H" ? "lower" : "upper",
            adopted: /ADOPTED/.test(a.raw) ? true : /REJ/.test(a.raw) ? false : null, date: a.date, url: (await exists(url, lastActed)) ? url : null,
          });
        }
      }
    }

    const events: NormalizedBill["events"] = [];
    for (const a of actions.filter((x) => /^PUBLIC HEARING/.test(x.raw) && /^\d{4}$/.test(x.q1))) {
      const day = `2026-${a.q1.slice(0, 2)}-${a.q1.slice(2)}`;
      const code = a.committee ?? "unknown";
      // Midnight Eastern marks a date with no time. Daylight time began March 8, 2026.
      const offset = day >= "2026-03-08" ? "-04:00" : "-05:00";
      // Nominations can show a hearing with no referral; no committee is assumed.
      const title = a.committee ? `${committee(a.committee)} public hearing` : "Public hearing";
      events.push({ providerEventId: `ct-hearing-${code}-${day}`, title, startsAt: `${day}T00:00:00${offset}`, location: null, kind: "hearing" });
    }

    const sponsors: NormalizedBill["sponsors"] = [...(introducersByBill.get(billNum) ?? [])]
      .sort((x, y) => (x.intro_type === y.intro_type ? Number(x.sort_order) - Number(y.sort_order) : x.intro_type === "I" ? -1 : 1))
      .map((r) => {
        const p = personByCode.get(r.intro_code);
        if (!p && !committeeName.has(r.intro_code)) unknownSponsors.add(r.intro_code);
        return {
          name: p?.name ?? committee(r.intro_code), type: r.intro_type === "I" ? ("primary" as const) : ("cosponsor" as const),
          providerPersonId: p?.providerPersonId ?? null, party: p?.party ?? null, district: p?.district ?? null, chamber: p?.chamber ?? null,
        };
      });

    const acts = versions.filter((v) => /Act No\./.test(v.label));
    const amended = amendmentsOut.length > 0 || actions.some((a) => /amend/i.test(a.description));
    const analysis = await analysisFor(billNum, versions, amended, lastActed);
    const fiscal = await fiscalFor(billNum, versions, amended, lastActed);
    const bill: NormalizedBill = {
      providerBillId: `ct-2026-${billNum}`, sessionProviderId: CT_SESSION.providerId, identifier: `${type} ${number}`, billType: type, number,
      chamber: origin, title: titleCase(b.bill_title), officialSummary: b.stmt_purp || null, analysis, fiscal,
      status: outcome.status, statusText: outcome.statusText, statusDate: outcome.statusDate, introducedAt: actions[0]?.date ?? null,
      lastActionAt: last?.date ?? null, lastActionText: last?.description ?? null, effectiveDate: null,
      subjects: [...new Set((subjectsByBill.get(billNum) ?? []).map((s) => s.subj_desc))].sort(),
      sourceUrls: [{ label: "Bill status, General Assembly", url: ctStatusUrl(billNum) }, ...acts.map((v) => ({ label: v.label, url: v.url! }))],
      changeHash: null, sourceUpdatedAt: null, sponsors, actions: timeline, versions, amendments: amendmentsOut, votes: billVotes,
      committees: [...committees].map(([code, referredAt]) => ({ providerCommitteeId: `ct-${code}`, name: committee(code), chamber: "joint", referredAt })),
      events, codeSections,
    };
    bill.changeHash = createHash("sha1").update(JSON.stringify(bill)).digest("hex").slice(0, 16);
    bills.push(bill);
    if (++done % 25 === 0) opts.onProgress?.(`${done} of ${rows.length} bills, ${requests} requests`);
  }

  const snapshot: CtSnapshot = {
    builtAt: new Date().toISOString(), sourceFilesDated: bills.reduce((m, b) => (b.lastActionAt && b.lastActionAt > m ? b.lastActionAt : m), ""),
    session: CT_SESSION, people: roster.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "code"))) as unknown as NormalizedPerson[],
    bills, versionTexts: texts, rollCallVotes,
  };
  if (Object.keys(rollCallVotes).length !== voteStats.floor + voteStats.tally - voteStats.noBill) {
    throw new Error("Two vote sheets share one id, so one would be lost");
  }
  const stats = {
    requests, analysisStats, fiscalStats, voteStats, problems, unmatched: [...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 40),
    voteProblems, unknownPhrases: [...unknownPhrases], unknownSponsors: [...unknownSponsors],
  };
  return { snapshot, stats };
}
