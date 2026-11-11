import type { BillPosition } from "../db/schema";

const PROCEDURAL = /\bamend(ment|ed)?\b|\btable\b|\brecommit\b|previous question|reconsider|adjourn|procedural|reserved for|vote to draft|motion failed|: change of reference/i;
export const isPassageVote = (motion: string) => !PROCEDURAL.test(motion);

export const isVoiceVote = (v: { yes: number; no: number; other?: number | null }) => v.yes + v.no + (v.other ?? 0) === 0;

export const MIN_VOTES_FOR_SCORE = 3;

type VoteOutcome = "with" | "against" | "missed";

export function voteOutcome(position: BillPosition | null | undefined, vote: string): VoteOutcome | null {
  if (position !== "support" && position !== "oppose") return null;
  if (vote !== "yes" && vote !== "no") return "missed";
  return (position === "support") === (vote === "yes") ? "with" : "against";
}
