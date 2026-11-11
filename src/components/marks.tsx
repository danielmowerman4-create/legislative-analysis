import { stableHash } from "@/lib/chamber";
import { cn } from "@/components/ui";

const LINES = ["M1 5.6C14 3.2 27 7.6 41 5.1S66 3.2 79 6 93 6.6 99 4.4", "M1 4.2C11 7 24 3.2 38 5.5S63 7.4 77 4.5 92 3.4 99 6",
  "M1 6.4C16 4.4 31 7.1 46 4.7S71 3.7 84 6.3 95 5.5 99 3.7"];

export function PenLine({ seed = "", className }: { seed?: string; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 100 10" preserveAspectRatio="none" className={cn("pen-line", className)}>
      <path d={LINES[stableHash(seed) % LINES.length]} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const CIRCLES = ["M12 9C28 2 59 1 71 9 83 18 71 37 41 38 14 39-3 31 3 19 8 9 28 4 47 4",
  "M62 6C46 1 17 2 7 13-3 25 16 38 40 38 66 38 80 27 70 14 63 5 42 3 25 7", "M16 7C33 1 63 3 72 13 80 25 62 38 36 37 10 36-3 27 4 15 9 8 25 5 44 5"];

export function PenCircle({ seed = "", draw }: { seed?: string; draw?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 76 42" preserveAspectRatio="none" className={cn("pen-circle", draw && "pen-draw")}>
      <path d={CIRCLES[stableHash(seed) % CIRCLES.length]} pathLength={1} />
    </svg>
  );
}

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: "2.6", strokeLinecap: "round" } as const;

export function PenCheck({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 22 20" className={cn("pen-draw overflow-visible", className)} {...STROKE} strokeLinejoin="round">
      <path d="M2.5 11.2C4.6 13 6.4 15 8 17.4 11 11.6 15 6.4 20 2.4" pathLength={1} />
    </svg>
  );
}

export function PenCross({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cn("overflow-visible", className)} {...STROKE}>
      <path d="M3.5 3C8 7.6 12.4 12.6 16.8 17.2M16.2 2.8C11.8 7.8 7.2 12.4 3 17.4" />
    </svg>
  );
}
