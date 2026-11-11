export type WhipStance = "yes" | "lean_yes" | "undecided" | "lean_no" | "no";
export type WhipRule = "majority" | "two_thirds";

export const WHIP_STANCES: WhipStance[] = ["yes", "lean_yes", "undecided", "lean_no", "no"];
export const WHIP_LABEL: Record<WhipStance, string> = { yes: "Yes", lean_yes: "Lean yes", undecided: "Undecided", lean_no: "Lean no", no: "No" };

export const votesNeeded = (seats: number, rule: WhipRule) => (rule === "two_thirds" ? Math.ceil((seats * 2) / 3) : Math.floor(seats / 2) + 1);
