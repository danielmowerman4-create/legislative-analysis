import { cn } from "@/components/ui";
import { monthDay } from "@/lib/format";

export type Sides = { support: number; oppose: number; other: number };

const SIDES = [["support", "Support", "bar-support"], ["oppose", "Oppose", "bar-oppose"], ["other", "Other", "bar-other"]] as const;

export function SplitBar({ sides, className, label }: { sides: Sides; className?: string; label?: string }) {
  const total = sides.support + sides.oppose + sides.other;
  if (!total) return null;
  const said = `${label ? `${label}: ` : ""}${sides.support} support, ${sides.oppose} oppose, ${sides.other} other`;
  return (
    <span role="img" aria-label={said} className={cn("flex h-3.5 w-full gap-0.5", className)}>
      {SIDES.filter(([key]) => sides[key] > 0).map(([key, , bar]) => (
        <span key={key} className={bar} style={{ flexGrow: sides[key], flexBasis: 0, minWidth: 4 }} />
      ))}
    </span>
  );
}

export function SplitKey({ sides, other = "Other" }: { sides: Sides; other?: string }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-base text-ink">
      {SIDES.map(([key, word, bar]) => (
        <li key={key} className="flex items-center gap-2.5">
          <span aria-hidden className={cn("inline-block size-3.5", bar)} />
          <span className="tabular font-semibold">{sides[key]}</span> {key === "other" ? other : word}
        </li>
      ))}
    </ul>
  );
}

export type WeekCount = Sides & { week: string };

// One column a week, tallest week sets the scale; the count sits on top of each column.
export function WeekBars({ weeks, height = 168 }: { weeks: WeekCount[]; height?: number }) {
  const total = (w: Sides) => w.support + w.oppose + w.other;
  const max = Math.max(1, ...weeks.map(total));
  return (
    <ol className="flex items-end gap-x-3 overflow-x-auto pb-1 sm:gap-x-5" aria-label="People who wrote, by week">
      {weeks.map((w) => (
        <li key={w.week} className="flex w-14 shrink-0 flex-col items-center"
          aria-label={`Week of ${monthDay(w.week)}: ${w.support} support, ${w.oppose} oppose, ${w.other} other`}>
          <span className="tabular text-sm font-semibold text-ink">{total(w) || ""}</span>
          <span className="mt-1 flex w-9 flex-col-reverse gap-0.5" style={{ height: Math.max(2, Math.round((total(w) / max) * height)) }}>
            {total(w) === 0 && <span className="h-0.5 w-full bg-line" />}
            {SIDES.filter(([key]) => w[key] > 0).map(([key, , bar]) => (
              <span key={key} className={bar} style={{ flexGrow: w[key], flexBasis: 0, minHeight: 3 }} />
            ))}
          </span>
          <span className="mt-2 text-sm whitespace-nowrap text-ink-2">{monthDay(w.week)}</span>
        </li>
      ))}
    </ol>
  );
}

// A plain count per row, drawn to the longest row.
export function CountBar({ value, max }: { value: number; max: number }) {
  return <span aria-hidden className="bar-support block h-3.5" style={{ width: `${Math.max(2, Math.round((value / Math.max(1, max)) * 100))}%` }} />;
}
