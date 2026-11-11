"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Kbd } from "@/components/ui";

type Result = { type: string; id: string; title: string; subtitle?: string; href: string };

const NAV: { label: string; href: string; keywords?: string }[] = [
  { label: "Today", href: "/today", keywords: "home briefing hearings moved" },
  { label: "Bills", href: "/bills", keywords: "search legislation find" },
  { label: "Tracked bills", href: "/tracked", keywords: "watchlist positions support oppose" },
  { label: "Calendar", href: "/calendar", keywords: "hearings schedule meetings floor" },
  { label: "Compare bills", href: "/compare", keywords: "what they do redline diff versions wording" },
  { label: "Committees", href: "/committees", keywords: "hearings referred" },
  { label: "Legislators", href: "/legislators", keywords: "members sponsors senators representatives" },
  { label: "Scorecards", href: "/scorecards", keywords: "allies opponents voting record" },
  { label: "Alerts for new bills", href: "/alerts", keywords: "watch keyword code subject sponsor" },
  { label: "Reports", href: "/reports", keywords: "export csv print" },
  { label: "Notifications", href: "/notifications", keywords: "alerts" },
  { label: "Team", href: "/team", keywords: "staff users roles" },
  { label: "Settings", href: "/settings", keywords: "office mfa data source legiscan" },
  { label: "Help", href: "/help", keywords: "support docs" },
];

const ACTIONS: { label: string; href: string }[] = [
  { label: "Bills with a hearing this week", href: "/bills?view=hearings" },
  { label: "Bills that moved this week", href: "/bills?view=moved" },
  { label: "Download tracked bills (CSV)", href: "/api/export/tracked" },
];

const GROUP = "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:kicker [&_[cmdk-group-heading]]:text-ink-3";
const ITEM = "cursor-pointer px-3 py-2 text-sm text-ink data-[selected=true]:bg-surface-2";

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("li:open-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("li:open-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    abort.current?.abort();
    if (q.length < 2) return;
    const ctl = new AbortController();
    abort.current = ctl;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { results: Result[] };
        setResults(body.results);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Search is unavailable right now.");
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    setQuery("");
    // Downloads are route handlers, not pages.
    if (href.startsWith("/api/")) window.location.assign(href);
    else router.push(href);
  };

  if (!open) return null;

  const navMatches = NAV.filter((n) => !query || `${n.label} ${n.keywords ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const actionMatches = ACTIONS.filter((a) => !query || a.label.toLowerCase().includes(query.toLowerCase()));

  const active = query.trim().length >= 2;
  const shown = active ? results : [];
  const groups = shown.reduce<Record<string, Result[]>>((acc, r) => {
    (acc[r.type] ??= []).push(r);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-navy-deep/70 px-4 pt-[12vh]" onMouseDown={() => setOpen(false)}>
      <Command
        label="Command menu"
        shouldFilter={false}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="paper w-full max-w-2xl overflow-hidden shadow-pop"
      >
        <div className="flex items-center gap-3 border-b border-line-strong px-5">
          <Search aria-hidden className="size-[18px] text-ink-3" strokeWidth={1.75} />
          <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Bill number, keyword, legislator or committee"
            className="h-16 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-3" />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto px-2 py-3 scroll-thin">
          {loading && (
            <Command.Loading>
              <div className="px-2 py-2 text-sm text-ink-3">Searching…</div>
            </Command.Loading>
          )}
          {active && error && <div className="px-2 py-2 text-sm text-danger">{error}</div>}
          {active && !loading && !error && shown.length === 0 && <div className="px-2 py-2 text-sm text-ink-3">No bills, legislators or committees match.</div>}
          {Object.entries(groups).map(([type, items]) => (
            <Command.Group key={type} heading={type} className={GROUP}>
              {items.map((r) => (
                <Command.Item key={`${r.type}:${r.id}`} value={`${r.type}:${r.id}`} onSelect={() => go(r.href)}
                  className="flex cursor-pointer flex-col px-3 py-2 text-sm data-[selected=true]:bg-surface-2">
                  <span className="truncate text-ink">{r.title}</span>
                  {r.subtitle && <span className="truncate text-ink-3">{r.subtitle}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          {navMatches.length > 0 && (
            <Command.Group heading="Go to" className={GROUP}>
              {navMatches.map((n) => <Command.Item key={n.href} value={`nav:${n.href}`} onSelect={() => go(n.href)} className={ITEM}>{n.label}</Command.Item>)}
            </Command.Group>
          )}
          {actionMatches.length > 0 && (
            <Command.Group heading="Actions" className={GROUP}>
              {actionMatches.map((a) => (
                <Command.Item key={a.href} value={`act:${a.href}`} onSelect={() => go(a.href)} className={ITEM}>{a.label}</Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </Command>
    </div>
  );
}

export function SearchButton() {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event("li:open-palette"))} title="Search bills, legislators and committees (⌘K)"
      className="inline-flex h-11 shrink-0 items-center gap-2 bg-forest px-4 text-base font-semibold whitespace-nowrap text-[oklch(0.985_0.004_150)] transition-colors duration-150 hover:bg-forest-deep sm:px-5">
      <Search aria-hidden className="size-4" strokeWidth={2} />
      Find a bill
    </button>
  );
}
