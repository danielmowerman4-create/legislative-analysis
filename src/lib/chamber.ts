export type ChamberMark = "yes" | "lean_yes" | "undecided" | "lean_no" | "no" | "not_voting";

export type ChamberSeat = { id: string; name: string; party: string | null; district: string | null; mark: ChamberMark };

const OUTER = 300;
const INNER = 118;
const MARGIN = 6;
const LARGEST_SEAT = 17;
const AISLES = 2;
const AISLE = 0.016; // share of the half circle each aisle takes

export function seatLayout(count: number) {
  const usable = 1 - AISLES * AISLE;
  let rows = 2;
  for (; rows < 14; rows++) {
    const step = (OUTER - INNER) / (rows - 1);
    const capacity = Array.from({ length: rows }, (_, i) => (Math.PI * usable * (INNER + step * i)) / step).reduce((a, b) => a + b, 0);
    if (capacity >= count) break;
  }
  const pitch = (OUTER - INNER) / (rows - 1);
  const radii = Array.from({ length: rows }, (_, i) => INNER + pitch * i);
  const total = radii.reduce((a, b) => a + b, 0);

  // Seats per row by length; leftovers go to the rows that lost most in rounding.
  const exact = radii.map((r) => (count * r) / total);
  const counts = exact.map(Math.floor);
  let left = count - counts.reduce((a, b) => a + b, 0);
  for (const i of exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) {
    if (left-- <= 0) break;
    counts[i]++;
  }

  const tightest = Math.min(pitch, ...radii.map((r, i) => (counts[i] ? (Math.PI * usable * r) / counts[i] : Infinity)));
  const seat = Math.min(LARGEST_SEAT, tightest * 0.42);
  const edge = OUTER + seat + MARGIN;
  const points = radii
    .flatMap((r, row) =>
      Array.from({ length: counts[row] }, (_, i) => {
        const along = (i + 0.5) / counts[row];
        const section = Math.min(AISLES, Math.floor(along * (AISLES + 1)));
        const angle = Math.PI * (1 - (along * usable + section * AISLE));
        return { x: edge + r * Math.cos(angle), y: edge - r * Math.sin(angle), angle };
      }),
    )
    .sort((a, b) => b.angle - a.angle)
    .map(({ x, y }) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }));

  return { width: edge * 2, height: edge + seat + MARGIN, seat: Math.round(seat * 10) / 10, points };
}

const partyRank = (party: string | null) => {
  const p = (party ?? "").trim().toUpperCase().slice(0, 1);
  return p === "D" ? 0 : p === "R" ? 2 : 1;
};

export function seatOrder<T extends { party: string | null; district: string | null; name: string }>(seats: T[]) {
  return [...seats].sort(
    (a, b) => partyRank(a.party) - partyRank(b.party) || (Number(a.district) || 0) - (Number(b.district) || 0) || a.name.localeCompare(b.name),
  );
}

export const voteMark = (vote: string): ChamberMark => (vote === "yes" || vote === "no" ? vote : "not_voting");

export function stableHash(text: string) {
  let h = 7;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
