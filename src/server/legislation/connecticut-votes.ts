export type MemberMark = { mark: "yes" | "no" | "not_voting" | "absent"; name?: string; district?: string };

export type FloorVote = {
  chamber: "lower" | "upper"; number: number; billNum: string; date: string;
  necessaryFor: "Passage" | "Adoption"; // "Passage" only on the House's final votes
  note: string; necessary: number; yes: number; no: number; absent: number; members: MemberMark[];
};

export type TallyVote = {
  billNum: string;
  committee: string; // from the file name, less the letter an amendment's sheet adds
  number: number; date: string | null; action: string; amendment: string | null;
  voice: "passed" | "failed" | null; // a voice vote prints the result, with no counts or names
  yes: number; no: number; abstain: number; absent: number; members: MemberMark[];
};

const FLOOR_FILE = /^2026([HS])V-(\d+)-R\d\d([A-Z]{2}\d+)-[HS]V/i;
const TALLY_FILE = /^2026[A-Z]{2}-\d+-R\d\d([A-Z]+)-CV(\d+)-TS/i;

const count = (text: string, label: RegExp) => {
  const m = text.match(label);
  return m ? Number(m[1]) : null;
};

const FLOOR_MARK: Record<string, MemberMark["mark"]> = { Y: "yes", N: "no", X: "not_voting", A: "absent" };

export function parseFloorVote(text: string, fileName: string): FloorVote | null {
  const file = fileName.match(FLOOR_FILE);
  if (!file) return null;
  const chamber = file[1].toUpperCase() === "H" ? ("lower" as const) : ("upper" as const);
  const taken = text.match(/Taken on\s+(\d{1,2})\/(\d{1,2})[ \t]*([^\n]*)/);
  const necessary = text.match(/Necessary for (Passage|Adoption)\s*\.*\s*(\d+)/);
  const yes = count(text, /Those voting Yea\s*\.*\s*(\d+)/);
  const no = count(text, /Those voting Nay\s*\.*\s*(\d+)/);
  const absent = count(text, /Those absent and not voting\s*\.*\s*(\d+)/);
  if (!taken || !necessary || yes === null || no === null || absent === null) return null;

  const start = text.indexOf("The following is the roll call vote");
  const rows = start >= 0 ? text.slice(start).split("\n").slice(1) : [];
  const members: MemberMark[] = [];
  for (const line of rows) {
    if (chamber === "upper") {
      for (const m of line.matchAll(/(?:^|\s)([YNXA])\s+(\d{1,2})\s+([A-Z][A-Z.'’\- ]*?)(?=\s{2,}|\s*$)/g)) {
        members.push({ mark: FLOOR_MARK[m[1]], district: String(Number(m[2])), name: m[3] });
      }
    } else {
      for (const m of line.matchAll(/(?:^|\s)([YNXA])\s+([A-Z][A-Z.,'’\- ]*?)(?=\s{2,}|\s*$)/g)) members.push({ mark: FLOOR_MARK[m[1]], name: m[2] });
    }
  }
  return {
    chamber, number: Number(file[2]), billNum: file[3].toUpperCase(), date: `2026-${taken[1].padStart(2, "0")}-${taken[2].padStart(2, "0")}`,
    necessaryFor: necessary[1] as FloorVote["necessaryFor"], note: taken[3].trim(), necessary: Number(necessary[2]), yes, no, absent, members,
  };
}

const TALLY_COLUMNS = ["yes", "no", "not_voting", "absent"] as const;
const TALLY_HEADS = ["yea", "nay", "abstain", "absent"];

export function parseTally(text: string, fileName: string): TallyVote | null {
  const file = fileName.match(TALLY_FILE);
  const bill = text.match(/Bill No\.:\s*([A-Z]{2}\d+)/);
  if (!file || !bill) return null;
  const letter = text.match(/Amendment Letter:[ \t]*([A-Z]{1,2})\b/)?.[1] ?? null;
  const code = letter && file[1].toUpperCase().endsWith(letter) ? file[1].toUpperCase().slice(0, -letter.length) : file[1].toUpperCase();
  const lines = text.split("\n");
  const totalsAt = lines.findIndex((l) => /^\s*TOTALS\b/.test(l));
  const totalsBlock = totalsAt >= 0 ? lines.slice(totalsAt, totalsAt + 3).join(" ") : "";
  const totals = (totalsBlock.match(/\d+/g) ?? []).map(Number);
  const voice = totals.length ? null : ((totalsBlock.match(/\b(Passed|Failed)\b/)?.[1].toLowerCase() ?? null) as TallyVote["voice"]);
  const voted = text.match(/Vote date:\s*(\d{2})\/(\d{2})\/(\d{4})/);

  let columns: { at: number; column: number }[] = [];
  const members: MemberMark[] = [];
  for (const line of lines) {
    if (/\byea\b.*\bnay\b.*\babstain\b.*\babsent\b/.test(line)) {
      columns = [...line.matchAll(/yea|nay|abstain|absent/g)].map((m) => ({ at: m.index + m[0].length / 2, column: TALLY_HEADS.indexOf(m[0]) }));
      continue;
    }
    const people = [...line.matchAll(/\b(?:Rep\.|Sen\.)\s+(.+?)\s+(S?\d{2,3})\b/g)];
    people.forEach((p, i) => {
      const from = p.index + p[0].length;
      const to = people[i + 1]?.index ?? line.length;
      const x = line.slice(from, to).indexOf("X");
      if (x < 0 || !columns.length) return;
      const at = from + x;
      const nearest = columns.reduce((best, c) => (Math.abs(c.at - at) < Math.abs(best.at - at) ? c : best));
      const seat = p[2].toUpperCase();
      const district = seat.startsWith("S") ? `S${Number(seat.slice(1))}` : String(Number(seat));
      members.push({ mark: TALLY_COLUMNS[nearest.column], name: p[1].trim(), district });
    });
  }
  return {
    billNum: bill[1], committee: code, number: Number(file[2]), date: voted ? `${voted[3]}-${voted[1]}-${voted[2]}` : null,
    action: text.match(/^\s*Action:[ \t]*([^\n]*)/m)?.[1].trim() ?? "", amendment: letter, voice,
    yes: totals[1] ?? 0, no: totals[2] ?? 0, abstain: totals[3] ?? 0, absent: totals[4] ?? 0, members,
  };
}

export const countMarks = (members: MemberMark[], ...marks: MemberMark["mark"][]) => members.filter((m) => marks.includes(m.mark)).length;

export function floorAddsUp(v: FloorVote) {
  return countMarks(v.members, "yes") === v.yes && countMarks(v.members, "no") === v.no && countMarks(v.members, "not_voting", "absent") === v.absent;
}

export function tallyAddsUp(v: TallyVote) {
  return countMarks(v.members, "yes") === v.yes && countMarks(v.members, "no") === v.no;
}

type ChamberAction = { date: string; description: string; classification: string[]; chamber: string | null };

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400_000;

// Sheets seldom say what a vote was on, so they are matched to that day's recorded actions.
export function nameFloorVotes(billType: string, votes: FloorVote[], actions: ChamberAction[]): Map<number, { motion: string; matched: boolean }> {
  const out = new Map<number, { motion: string; matched: boolean }>();
  const house = votes[0]?.chamber === "lower" ? "House" : "Senate";
  const chamber = votes[0]?.chamber;
  if (/^(HJ|SJ|HR|SR)$/.test(billType)) {
    for (const v of votes) out.set(v.number, { motion: `${house} adoption`, matched: true });
    return out;
  }
  const days = [...new Set(votes.map((v) => v.date))];
  for (const day of days) {
    const today = votes.filter((v) => v.date === day).sort((a, b) => a.number - b.number);
    const near = actions.filter((a) => a.chamber === chamber && daysApart(a.date, day) <= 1);
    const passedToday = near.some((a) => a.classification.includes("passed"));
    const finals = today.filter((v) => v.necessaryFor === "Passage");
    let final: FloorVote | undefined;
    if (chamber === "lower") final = finals.at(-1);
    else if (passedToday) final = [...today].reverse().find((v) => v.yes >= v.necessary);
    const rest = today.filter((v) => v !== final);
    const amendmentsNear = near.filter((a) => a.classification.includes("amendment"));
    const adopted = amendmentsNear.filter((a) => /adopted/.test(a.description));
    const rejected = amendmentsNear.filter((a) => /rejected/.test(a.description));
    const carried = rest.filter((v) => v.yes >= v.necessary);
    const lost = rest.filter((v) => v.yes < v.necessary);
    const named = (a: ChamberAction) => a.description.match(/(?:House|Senate) Amendments? [A-Z](?:[, ]+(?:and )?[A-Z])*\b/)?.[0];
    // Order is trusted only on an exact count; a chamber can adopt an amendment by voice.
    const label = (group: FloorVote[], source: ChamberAction[]) => {
      const exact = group.length === source.length;
      group.forEach((v, i) => {
        const name = exact ? named(source[i]) : undefined;
        const fallback = amendmentsNear.length ? `${house} amendment vote` : `${house} procedural vote`;
        out.set(v.number, name ? { motion: name, matched: true } : { motion: fallback, matched: false });
      });
    };
    label(carried, adopted);
    label(lost, rejected);
    if (final) out.set(final.number, { motion: `${house} passage`, matched: true });
  }
  return out;
}
