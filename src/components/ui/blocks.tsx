import Link from "next/link";
import type { ReactNode } from "react";
import { ViewTransition } from "react";
import { ActionLink, cn } from "./index";
import { PenLine } from "@/components/marks";
import { dateOnly, relative } from "@/lib/format";

type SectionProps = { title: ReactNode; meta?: ReactNode; href?: string; linkLabel?: string; children: ReactNode; id?: string; titleClass?: string };

export function Section({ title, meta, href, linkLabel, children, id, titleClass }: SectionProps) {
  const hid = id ?? (typeof title === "string" ? `s-${title.toLowerCase().replace(/\W+/g, "-")}` : undefined);
  return (
    <section aria-labelledby={hid} className="rise-on-view grid gap-x-14 gap-y-5 py-11 lg:grid-cols-[272px_minmax(0,1fr)] lg:py-16">
      <div>
        <h2 id={hid} className={cn("rail-title text-[46px] text-ink lg:text-[60px]", titleClass)}>{title}</h2>
        {meta && <div className="mt-2 text-base text-ink-2">{meta}</div>}
        {href && linkLabel && <ActionLink href={href} className="mt-4">{linkLabel}</ActionLink>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

type FreshnessProps = { at: Date | string | null | undefined; stale?: boolean; label?: string; snapshotAt?: Date | null };

export function Freshness({ at, stale, label = "Updated", snapshotAt }: FreshnessProps) {
  if (snapshotAt) return <span className="text-sm whitespace-nowrap text-ink-3">Official files from {dateOnly(snapshotAt)}</span>;
  return (
    <span className={cn("text-sm whitespace-nowrap", stale ? "text-warn-ink" : "text-ink-3")}>
      {at ? `${label} ${relative(at)}` : "Not synced yet"}
      {stale && at ? " · out of date" : ""}
    </span>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="border-t border-line text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="grid gap-x-8 gap-y-0.5 border-b border-line py-3 sm:grid-cols-[160px_minmax(0,1fr)]">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 text-ink">{v ?? "None"}</dd>
        </div>
      ))}
    </dl>
  );
}

type TabsProps = { name: string; items: { key: string; label: string; href: string; count?: number }[]; current: string; className?: string };

export function Tabs({ name, items, current, className }: TabsProps) {
  return (
    <nav aria-label="Views" className={cn("-mx-1 flex shrink-0 gap-8 overflow-x-auto px-1 [scrollbar-width:none]", className)}>
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          scroll={false}
          transitionTypes={["list"]}
          aria-current={t.key === current ? "page" : undefined}
          className={cn("relative flex h-12 items-center gap-1.5 text-sm whitespace-nowrap transition-colors duration-150",
            t.key === current ? "font-semibold text-ink" : "text-ink-2 hover:text-ink")}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="tabular font-normal text-ink-3">{t.count}</span>}
          {t.key === current && (
            <ViewTransition name={`tab-line-${name}`} share="line-slide" default="none">
              <PenLine seed={t.key} className="absolute bottom-1 -left-0.5 w-[calc(100%+4px)]" />
            </ViewTransition>
          )}
        </Link>
      ))}
    </nav>
  );
}

type SegmentedProps = { label: string; items: { key: string; label: string; href: string }[]; current: string; showLabel?: boolean; center?: boolean };

export function Segmented({ label, items, current, showLabel = true, center }: SegmentedProps) {
  return (
    <div className={cn("flex flex-wrap items-baseline gap-x-5 gap-y-1", center && "justify-center")}>
      {showLabel && <span className="kicker text-ink-3">{label}</span>}
      <div role="group" aria-label={label} className={cn("flex flex-wrap gap-x-5 gap-y-1", center && "justify-center")}>
        {items.map((i) => (
          <Link
            key={i.key}
            href={i.href}
            scroll={false}
            transitionTypes={["list"]}
            aria-current={i.key === current ? "true" : undefined}
            className={cn("relative pb-1.5 text-sm transition-colors duration-150", i.key === current ? "font-semibold text-ink" : "text-ink-2 hover:text-ink")}
          >
            {i.label}
            {i.key === current && <PenLine seed={i.key} className="absolute bottom-0 -left-0.5 w-[calc(100%+4px)]" />}
          </Link>
        ))}
      </div>
    </div>
  );
}
