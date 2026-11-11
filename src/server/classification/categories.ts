import { BILL_REQUESTS, type MessageTypeKey } from "./schema";

export const STAFF_CATEGORIES = {
  constituent: "Constituents",
  advocacy: "Advocacy and lobbyists",
  government: "Government",
  media: "Media",
  vendor: "Vendors",
  newsletter: "Newsletters",
  internal: "Internal",
  uncertain: "Uncertain",
} as const;

export type StaffCategory = keyof typeof STAFF_CATEGORIES;

export const CATEGORY_TYPES: Record<Exclude<StaffCategory, "internal" | "uncertain">, MessageTypeKey[]> = {
  constituent: ["constituent_policy", "constituent_service", "meeting_request", "constituent_general"],
  advocacy: ["organization", "advocacy_lobbyist"],
  government: ["government_agency"],
  media: ["media"],
  vendor: ["vendor"],
  newsletter: ["newsletter_automated"],
};

export function staffCategoryOf(types: MessageTypeKey[], isInternal: boolean): StaffCategory {
  if (isInternal || types[0] === "legislative_staff") return "internal";
  for (const [key, list] of Object.entries(CATEGORY_TYPES)) if (types[0] && list.includes(types[0])) return key as StaffCategory;
  return "uncertain";
}

export type BillRequestKey = (typeof BILL_REQUESTS)[number];

export const BILL_REQUEST_LABEL: Record<BillRequestKey, string> = {
  vote_yes: "Vote yes",
  vote_no: "Vote no",
  amend: "Amend it",
  cosponsor: "Co-sponsor it",
  hearing: "Give it a hearing",
  information: "Wants information",
};

const REQUESTS: [BillRequestKey, RegExp][] = [
  ["cosponsor", /\bco-?\s?sponsor/i],
  ["amend", /\bamend(?:ed|ment|ing)?\b/i],
  ["hearing", /\b(?:hold|schedule|give\s+it)\s+a\s+hearing\b|\bbring\s+[^.!?]{0,40}\bto\s+(?:a\s+)?(?:vote|the\s+floor)\b/i],
  ["vote_no", /\bvote\s+(?:no|against|down)\b|\b(?:defeat|reject)\s+(?:this|the|it|[A-Z]{2,3}\s*\d)/i],
  ["vote_yes", /\bvote\s+(?:yes|for|in\s+favor)\b|\b(?:please|urge\s+you\s+to)\s+(?:pass|support)\b/i],
  ["information", /\bstatus\b|\bwhere\s+(?:do\s+you|does\s+it|things)\s+stand\b|\bwhen\s+will\b/i],
];

export function billRequestIn(text: string): BillRequestKey | null {
  return REQUESTS.find(([, re]) => re.test(text))?.[0] ?? null;
}
