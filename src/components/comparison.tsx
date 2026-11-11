import { cn } from "@/components/ui";
import { Segmented } from "@/components/ui/blocks";
import type { SectionChange, VersionComparison } from "@/server/legislation/diff";

const TAG_LABEL = { definitions: "Definitions", appropriations: "Dollar amounts", dates: "Dates" } as const;
const STATUS_LABEL = { added: "Added", removed: "Removed", modified: "Changed", unchanged: "Same" } as const;

// Bills can run to millions of characters; paging keeps the browser responsive.
const PAGE_CHARS = 80_000;
const SECTION_CHARS = 60_000;
const sizeOf = (s: SectionChange) => s.parts.reduce((n, p) => n + p.value.length, 0);

function paginate(sections: SectionChange[]) {
  const pages: SectionChange[][] = [];
  let used = 0;
  for (const whole of sections) {
    let room = SECTION_CHARS;
    const s = {
      ...whole,
      parts: whole.parts.flatMap((p) => {
        if (room <= 0) return [];
        const value = p.value.slice(0, room);
        room -= value.length;
        return [{ ...p, value }];
      }),
    };
    if (!pages.length || used + sizeOf(s) > PAGE_CHARS) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(s);
    used += sizeOf(s);
  }
  return pages;
}

const anchor = (s: SectionChange) => `sec-${s.label.toLowerCase().replace(/\W+/g, "-")}`;
const sectionTitle = (s: SectionChange) => (s.heading ? `${s.label}. ${s.heading}` : s.label);
const tone = (s: SectionChange) => (s.status === "added" ? "text-ok" : s.status === "removed" ? "text-danger" : null);
const PAGE_LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4";

type Layout = "side" | "inline";
type ComparisonViewProps = { comparison: VersionComparison; leftLabel: string; rightLabel: string; layout: Layout; layoutHref: (l: Layout) => string;
  page?: number; pageHref?: (n: number) => string };

export function ComparisonView({ comparison, leftLabel, rightLabel, layout, layoutHref, page = 1, pageHref }: ComparisonViewProps) {
  const pages = paginate(comparison.sections.filter((s) => s.status !== "unchanged"));
  const current = Math.min(Math.max(page, 1), Math.max(pages.length, 1));
  const changed = pages[current - 1] ?? [];
  const c = comparison.counts;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Changes" className="min-w-0 lg:sticky lg:top-[96px] lg:self-start">
        <p className="tabular text-sm text-ink">
          <span className="font-semibold">{c.modified + c.added + c.removed}</span> of {comparison.sections.length} sections differ
        </p>
        <p className="tabular mt-0.5 text-sm text-ink-3">{c.modified} changed · {c.added} added · {c.removed} removed</p>
        <ol className="mt-4 flex flex-col">
          {changed.map((s) => (
            <li key={s.label} className="border-b border-line">
              <a href={`#${anchor(s)}`} className="flex items-baseline justify-between gap-3 py-2 text-sm hover:text-ink">
                <span className="min-w-0 truncate text-ink-2">{sectionTitle(s)}</span>
                <span className={cn("shrink-0", tone(s) ?? "text-ink-3")}>{STATUS_LABEL[s.status]}</span>
              </a>
            </li>
          ))}
        </ol>
        <div className="mt-5">
          <Segmented label="Layout" showLabel={false} current={layout} items={[
            { key: "side", label: "Side by side", href: layoutHref("side") },
            { key: "inline", label: "One column", href: layoutHref("inline") },
          ]} />
        </div>
      </nav>

      <div className="flex min-w-0 flex-col gap-6">
        {comparison.findings.length > 0 && (
          <section>
            <h2 className="rail-title mb-3 text-lg text-ink">What differs</h2>
            <ul className="flex max-w-[80ch] flex-col text-sm text-ink">
              {comparison.findings.map((f, i) => (
                <li key={i} className="py-2.5">{f}</li>
              ))}
            </ul>
          </section>
        )}
        {changed.length === 0 && <p className="text-sm text-ink">The two texts are the same.</p>}
        {layout === "side" && changed.length > 0 && (
          <div className="sticky top-[72px] z-10 hidden grid-cols-2 gap-10 bg-bg py-2.5 md:grid">
            <span className="kicker text-ink">{leftLabel}</span>
            <span className="kicker text-ink">{rightLabel}</span>
          </div>
        )}
        {changed.map((s) => (
          <section key={s.label} id={anchor(s)} className="scroll-mt-32 border-b border-line pb-6">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="font-display text-md font-medium text-ink">{sectionTitle(s)}</h3>
              <span className={cn("text-sm", tone(s) ?? "text-ink-2")}>{STATUS_LABEL[s.status]}</span>
              {s.tags.length > 0 && <span className="text-sm text-ink-3">{s.tags.map((t) => TAG_LABEL[t]).join(", ")} differ</span>}
            </div>
            {layout === "side" ? (
              <div className="grid gap-x-10 gap-y-3 md:grid-cols-2">
                <TextPane label={leftLabel} parts={s.parts.filter((p) => !p.added)} empty={s.status === "added" ? `Not in ${leftLabel}` : null} />
                <TextPane label={rightLabel} parts={s.parts.filter((p) => !p.removed)} empty={s.status === "removed" ? `Not in ${rightLabel}` : null} />
              </div>
            ) : (
              <TextPane parts={s.parts} />
            )}
          </section>
        ))}
        {pages.length > 1 && pageHref && (
          <nav aria-label="Pages" className="flex items-center justify-between gap-6 text-base">
            {current > 1 ? <a href={pageHref(current - 1)} className={PAGE_LINK}>Previous</a> : <span />}
            <span className="tabular text-ink-2">Page {current} of {pages.length}</span>
            {current < pages.length ? <a href={pageHref(current + 1)} className={PAGE_LINK}>Next</a> : <span />}
          </nav>
        )}
      </div>
    </div>
  );
}

function TextPane({ label, parts, empty }: { label?: string; parts: SectionChange["parts"]; empty?: string | null }) {
  return (
    <div className="min-w-0">
      {label && <p className="kicker mb-1.5 text-ink-3 md:hidden">{label}</p>}
      {empty ? (
        <p className="text-sm text-ink-3 italic">{empty}</p>
      ) : (
        <p className="max-w-[75ch] text-base leading-7 whitespace-pre-wrap text-ink">
          {parts.map((p, i) => (
            <span key={i} className={p.added ? "diff-add" : p.removed ? "diff-del" : undefined}>
              {p.added && <span className="sr-only">[added] </span>}
              {p.removed && <span className="sr-only">[removed] </span>}
              {p.value}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
