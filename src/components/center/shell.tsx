"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, ViewTransition, type ReactNode } from "react";
import { ArrowLeft, Menu, X } from "lucide-react";
import { cn, Sep } from "@/components/ui";
import { PenLine } from "@/components/marks";
import { PageTransition, Tick } from "@/components/motion";

export const ROOT = "/constituent-center";

type RailCounts = { needsPerson: number; urgent: number; newMail: number; openCases: number; drafts: number; ledgerProblems: number };
type RailAccess = { cases: boolean; contacts: boolean; replies: boolean; ledger: boolean };

type Item = { href: string; label: string; count?: number; alert?: boolean };

function groups(c: RailCounts, a: RailAccess): Item[][] {
  return [
    [
      { href: ROOT, label: "Needs a person", count: c.needsPerson, alert: c.urgent > 0 },
      { href: `${ROOT}/mail`, label: "All mail", count: c.newMail },
      { href: `${ROOT}/form-letters`, label: "Form letters" },
    ],
    [...(a.cases ? [{ href: `${ROOT}/casework`, label: "Casework", count: c.openCases }] : []), ...(a.contacts ? [{ href: `${ROOT}/people`, label: "People" }]
      : []), ...(a.replies ? [{ href: `${ROOT}/replies`, label: "Replies", count: c.drafts }] : [])],
    [{ href: `${ROOT}/topics`, label: "Topics" }, ...(a.ledger ? [{ href: `${ROOT}/every-message`, label: "Every message", count: c.ledgerProblems,
      alert: c.ledgerProblems > 0 }] : []), { href: `${ROOT}/setup`, label: "Settings" }],
  ].filter((g) => g.length > 0);
}

const isActive = (pathname: string, href: string) => (href === ROOT ? pathname === ROOT : pathname === href || pathname.startsWith(`${href}/`));

// Only one list on screen may `slide`: a view-transition name must be unique.
type NavProps = { pathname: string; slide?: boolean; onNavigate?: () => void };

function Nav({ list, ...props }: NavProps & { list: Item[][] }) {
  return (
    <div className="flex flex-col gap-4">
      {list.map((group) => (
        <NavGroup key={group[0].href} list={group} {...props} />
      ))}
    </div>
  );
}

function NavGroup({ list, pathname, slide, onNavigate }: NavProps & { list: Item[] }) {
  return (
    <ul className="flex flex-col">
      {list.map((i) => {
        const on = isActive(pathname, i.href);
        const line = <PenLine seed={i.href} className="absolute -bottom-1 -left-0.5 w-[calc(100%+4px)]" />;
        return (
          <li key={i.href}>
            <Link href={i.href} onClick={onNavigate} aria-current={on ? "page" : undefined}
              className={cn("group/nav relative flex items-baseline justify-between gap-4 py-1.5 text-lg transition-colors duration-150",
              on ? "font-semibold text-ink" : "text-ink-2 hover:text-ink")}>
              <span className="relative transition-transform duration-200 ease-(--expo) group-hover/nav:translate-x-0.5">
                {i.label}
                {on &&
                  (slide ? (
                    <ViewTransition name="center-nav-line" share="line-slide" default="none">{line}</ViewTransition>
                  ) : (
                    line
                  ))}
              </span>
              {i.count ? (
                <span className={cn("tabular text-base", i.alert ? "font-semibold text-danger" : "text-ink-3")}
                  aria-label={`${i.count}${i.alert ? ", needs attention" : ""}`}>
                  <Tick value={i.count} />
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function BackToBills({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  return (
    // No prefetch: Today's photographs would download on every screen here.
    <Link href="/today" prefetch={false} onClick={onNavigate}
      className={cn("group/back flex items-center gap-2 text-base font-semibold text-ink-2 transition-colors duration-150 hover:text-ink", className)}>
      <ArrowLeft aria-hidden className="size-4 transition-transform duration-150 group-hover/back:-translate-x-0.5" strokeWidth={2} />
      Back to bills
    </Link>
  );
}

type CenterShellProps = { counts: RailCounts; access: RailAccess; office: { name: string; detail: string }; demo: boolean; user: ReactNode;
  children: ReactNode };

export function CenterShell({ counts, access, office, demo, user, children }: CenterShellProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const list = groups(counts, access);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] min-[90rem]:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="band band-forest no-print hidden lg:block" style={{ viewTransitionName: "center-rail" }}>
        <div className="sticky top-0 flex h-screen flex-col">
          <div className="scroll-thin min-h-0 overflow-y-auto pt-6 pr-8 pb-8 pl-8 xl:pr-10">
            <BackToBills />
            <Link href={ROOT} className="anchor mt-6 block text-[58px] leading-[0.88] text-chalk min-[90rem]:text-[64px]">Constituent<br />Center</Link>
            <p className="mt-3 text-sm text-ink-2">{office.name}</p>
            <nav aria-label="Constituent Center" className="mt-5"><Nav list={list} pathname={pathname} slide /></nav>
          </div>
        </div>
      </aside>

      <header className="band band-forest no-print sticky top-0 z-30 lg:hidden">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <Link href={ROOT} className="anchor text-[30px] leading-none text-chalk">Constituent Center</Link>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            className="flex h-10 items-center gap-1.5 text-sm font-semibold text-ink">
            {open ? <X aria-hidden className="size-5" strokeWidth={1.75} /> : <Menu aria-hidden className="size-5" strokeWidth={1.75} />}
            Menu
          </button>
        </div>
        {open && (
          <nav aria-label="Constituent Center" className="menu-in px-6 pb-6">
            <Nav list={list} pathname={pathname} onNavigate={() => setOpen(false)} />
            <BackToBills className="mt-4 text-ink" onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </header>

      <div className="relative z-10 flex min-w-0 flex-col">
        <div className="no-print relative z-10 flex items-center justify-between gap-6 px-6 pt-5 text-sm text-ink-2 lg:pr-14 lg:pl-10">
          <p className="flex min-w-0 items-center">
            {demo && (
              <span className="flex shrink-0 items-center">
                <span className="font-semibold text-ink">Made-up mail for practice</span>
                <Sep className="hidden sm:inline" />
              </span>
            )}
            <span className={cn("truncate", demo && "hidden sm:inline")}>{office.detail || office.name}</span>
          </p>
          <div className="paper shrink-0">{user}</div>
        </div>
        <main id="main" className="flex min-w-0 flex-1 flex-col px-6 pb-20 lg:pr-14 lg:pl-10"><PageTransition>{children}</PageTransition></main>
      </div>
    </div>
  );
}
