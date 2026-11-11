import type { ActionClass, BillStatus } from "../db/schema";

type StageKey = "introduced" | "origin_committee" | "origin_passed" | "second_committee" | "second_passed" | "governor" | "law";
export type Stage = { key: StageKey; label: string; date: string | null; state: "done" | "current" | "upcoming" | "stopped" };
export type Outcome = { kind: "failed" | "vetoed" | "withdrawn"; label: string; date: string | null } | null;

type Action = { actionDate: string; chamber: string | null; classification: ActionClass[] | string[]; description: string };

const CHAMBER_NAME = { lower: "House", upper: "Senate" } as const;

export const isSimpleResolution = (billType: string) => /^(HR|SR)$/i.test(billType);

const isJointResolution = (billType: string) => /^(HJ|SJ)$/i.test(billType);

type BillLike = { chamber: string; billType: string; status: BillStatus; statusText?: string | null };

// jointCommittees (Connecticut): one committee stage, before the first chamber acts.
export function billStages(bill: BillLike, actions: Action[], opts: { jointCommittees?: boolean } = {}): { stages: Stage[]; outcome: Outcome } {
  const asc = [...actions].sort((a, b) => a.actionDate.localeCompare(b.actionDate));
  const origin = bill.chamber === "upper" ? "upper" : "lower";
  const other = origin === "upper" ? "lower" : "upper";
  const has = (a: Action, c: ActionClass) => (a.classification as string[]).includes(c);
  const first = (pred: (a: Action) => boolean) => asc.find(pred)?.actionDate ?? null;
  const inCommittee = (a: Action) => has(a, "referred") || has(a, "committee_action");

  const introduced = asc[0]?.actionDate ?? null;
  const originPassed = first((a) => has(a, "passed") && (a.chamber === origin || a.chamber === null));
  const originCommittee = first((a) => inCommittee(a) && a.chamber !== other && (!originPassed || a.actionDate <= originPassed));
  const secondCommittee = originPassed ? first((a) => inCommittee(a) && a.chamber === other && a.actionDate >= originPassed) : null;
  const secondPassed = originPassed ? first((a) => has(a, "passed") && a.chamber === other && a.actionDate >= originPassed) : null;
  const signed = first((a) => has(a, "signed"));
  const vetoed = first((a) => has(a, "vetoed"));
  const toGovernor = first((a) => /governor/i.test(a.description) && !has(a, "signed") && !has(a, "vetoed")) ?? signed ?? vetoed;

  const o = CHAMBER_NAME[origin];
  const s = CHAMBER_NAME[other];
  const stages: Omit<Stage, "state">[] = opts.jointCommittees
    ? [
        { key: "introduced", label: "Introduced", date: introduced },
        { key: "origin_committee", label: "Committee", date: first(inCommittee) },
        ...(isSimpleResolution(bill.billType)
          ? [{ key: "origin_passed" as const, label: "Adopted", date: originPassed }]
          : isJointResolution(bill.billType)
            ? [
                { key: "origin_passed" as const, label: `Adopted ${o}`, date: originPassed },
                { key: "second_passed" as const, label: `Adopted ${s}`, date: secondPassed },
              ]
            : [
                { key: "origin_passed" as const, label: `Passed ${o}`, date: originPassed },
                { key: "second_passed" as const, label: `Passed ${s}`, date: secondPassed },
                { key: "governor" as const, label: "Governor", date: toGovernor },
                { key: "law" as const, label: "Law", date: signed },
              ]),
      ]
    : isSimpleResolution(bill.billType)
    ? [
        { key: "introduced", label: "Introduced", date: introduced },
        { key: "origin_committee", label: `${o} committee`, date: originCommittee },
        { key: "origin_passed", label: "Adopted", date: originPassed },
      ]
    : [
        { key: "introduced", label: "Introduced", date: introduced },
        { key: "origin_committee", label: `${o} committee`, date: originCommittee },
        { key: "origin_passed", label: `Passed ${o}`, date: originPassed },
        { key: "second_committee", label: `${s} committee`, date: secondCommittee },
        { key: "second_passed", label: `Passed ${s}`, date: secondPassed },
        { key: "governor", label: "Governor", date: toGovernor },
        { key: "law", label: "Law", date: signed },
      ];

  // A later stage reached implies the earlier ones happened even when no action records them.
  let reached = stages.findLastIndex((st) => st.date);
  if (bill.status === "enacted") reached = stages.length - 1;
  else if (bill.status === "passed_both") reached = Math.max(reached, stages.findIndex((st) => st.key === "second_passed"));
  else if (bill.status === "passed_chamber") reached = Math.max(reached, stages.findIndex((st) => st.key === "origin_passed"));
  else if (bill.status === "in_committee") reached = Math.max(reached, stages.findIndex((st) => st.key === "origin_committee"));

  const failedAt = first((a) => has(a, "failed"));
  const outcome: Outcome =
    bill.status === "vetoed"
      ? { kind: "vetoed", label: "Vetoed", date: vetoed }
      : bill.status === "failed"
        ? { kind: "failed", label: (opts.jointCommittees && bill.statusText) || "Did not pass", date: failedAt }
        : bill.status === "withdrawn"
          ? { kind: "withdrawn", label: "Withdrawn", date: failedAt }
          : null;

  return {
    outcome,
    stages: stages.map((st, i) => ({
      ...st,
      state: i <= reached ? "done" : i === reached + 1 ? (outcome ? "stopped" : "current") : "upcoming",
    })),
  };
}

const STEP = new Map<BillStatus, number>([
  ["introduced", 0], ["in_committee", 1], ["passed_chamber", 2], ["passed_both", 4], ["sent_to_executive", 5], ["enacted", 6],
]);
export const statusStep = (status: BillStatus) => STEP.get(status) ?? -1;

export function sponsorSpectrum(parties: (string | null)[]) {
  const counts = new Map<string, number>();
  for (const p of parties) {
    const k = (p ?? "").trim().toUpperCase().slice(0, 1);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const NAMES: Record<string, string> = { R: "Republican", D: "Democratic", I: "Independent" };
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (parts.length === 1) return `${NAMES[parts[0][0]] ?? parts[0][0]} sponsors only (${parts[0][1]})`;
  return `Bipartisan (${parts.map(([k, n]) => `${n} ${k}`).join(", ")})`;
}
