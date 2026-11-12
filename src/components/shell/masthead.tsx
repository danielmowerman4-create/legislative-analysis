"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, ViewTransition, type ReactNode } from "react";
import { ChevronDown, Menu, X } from "lucide-react";
import { cn, Sep } from "@/components/ui";
import { Tick } from "@/components/motion";
import { PenLine } from "@/components/marks";
import { SearchButton } from "./command-palette";
import { Wordmark } from "./brand";

type Item = { href: string; label: string; count?: number; countLabel?: string };

function isActive(pathname: string, href: string) {
  const compare = pathname.endsWith("/compare");
  if (href === "/compare") return pathname === href || compare;
  if (href === "/bills" && compare) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

const BAR_LINK = "relative flex h-full items-center gap-1.5 text-base whitespace-nowrap transition-colors duration-150";
const BAR_ON = "font-semibold text-ink";
const BAR_OFF = "text-ink-2 hover:text-ink";

function NavLine({ seed }: { seed: string }) {
  return (
    <ViewTransition name="nav-line" share="line-slide" default="none">
      <PenLine seed={seed} className="absolute bottom-3.5 -left-0.5 w-[calc(100%+4px)]" />
    </ViewTransition>
  );
}

function MoreMenu({ items, pathname }: { items: Item[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = items.find((i) => isActive(pathname, i.href));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- route change closes the menu
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative h-full">
      <button type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} className={cn(BAR_LINK, current ? BAR_ON : BAR_OFF)}>
        {current?.label ?? "More"}
        <ChevronDown aria-hidden className={cn("size-4 text-ink-3 transition-transform duration-200 ease-out-quart", open && "rotate-180")}
          strokeWidth={1.75} />
        {current && <NavLine seed={current.href} />}
      </button>
      {open && (
        <div role="menu" className="menu-in absolute top-full right-0 z-40 w-56 bg-bg py-1.5 shadow-pop">
          {items.map((i) => (
            <Link key={i.href} role="menuitem" href={i.href} aria-current={isActive(pathname, i.href) ? "page" : undefined}
              className={cn("block px-4 py-2.5 text-base text-ink transition-colors hover:bg-surface-2", isActive(pathname, i.href) && "font-semibold")}>
              {i.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

type MastheadProps = { counts: { tracked: number; hearingsThisWeek: number; unreadNotifications: number }; office: { name: string; detail: string };
  session: string | null; demo: boolean; center: boolean; user: ReactNode };

export function Masthead({ counts, office, session, demo, center, user }: MastheadProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- route change closes the full-screen menu
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const work: Item[] = [
    { href: "/today", label: "Today" },
    { href: "/bills", label: "Bills" },
    { href: "/tracked", label: "Tracked", count: counts.tracked, countLabel: "tracked bills" },
    { href: "/calendar", label: "Calendar", count: counts.hearingsThisWeek, countLabel: "hearings this week on tracked bills" },
    { href: "/press", label: "Press" },
    { href: "/compare", label: "Compare" },
  ];
  const research: Item[] = [
    { href: "/committees", label: "Committees" },
    { href: "/legislators", label: "Legislators" },
    { href: "/scorecards", label: "Scorecards" },
    { href: "/reports", label: "Reports" },
  ];
  const office_: Item[] = [
    { href: "/alerts", label: "Alerts" },
    { href: "/notifications", label: "Notifications", count: counts.unreadNotifications, countLabel: "unread" },
    { href: "/settings", label: "Settings" },
    { href: "/team", label: "Team" },
    { href: "/help", label: "Help" },
  ];

  const barLink = (item: Item) => {
    const active = isActive(pathname, item.href);
    return (
      <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn(BAR_LINK, active ? BAR_ON : BAR_OFF)}>
        {item.label}
        {item.count ? (
          <span className="tabular font-normal text-ink-3" aria-label={`${item.count} ${item.countLabel}`}><Tick value={item.count} /></span>
        ) : null}
        {active && <NavLine seed={item.href} />}
      </Link>
    );
  };

  return (
    <>
      <div className="band no-print bg-navy-deep">
        <div className="wrap flex h-9 items-center justify-between gap-6 text-xs text-ink-2">
          <p className="flex min-w-0 items-center">
            {demo && (
              <span className="flex shrink-0 items-center">
                <span className="font-semibold text-chalk" title="Fictional bills, legislators and events for “Demo State”">Demo data</span>
                <Sep />
              </span>
            )}
            <span className="truncate">{office.name}</span>
            {office.detail && (
              <span className="hidden shrink-0 items-center md:flex"><Sep />{office.detail}</span>
            )}
            {session && <span className="hidden shrink-0 items-center lg:flex"><Sep />{session}</span>}
          </p>
          <div className="flex shrink-0 items-center gap-6">
            {center && (
              <Link href="/constituent-center" className="font-semibold whitespace-nowrap text-chalk transition-colors hover:text-ink xl:hidden">
                Constituent Center
              </Link>
            )}
            <Link href="/alerts" className="hidden transition-colors hover:text-ink sm:inline">Alerts</Link>
            <Link href="/notifications" className="hidden transition-colors hover:text-ink sm:inline"
              aria-label={`Notifications${counts.unreadNotifications ? `, ${counts.unreadNotifications} unread` : ""}`}>
              Notifications
              {counts.unreadNotifications > 0 && <span className="ml-1.5 font-semibold text-ink tabular">{counts.unreadNotifications}</span>}
            </Link>
            {user}
          </div>
        </div>
      </div>

      <header className="no-print sticky top-0 z-30 border-b border-line bg-bg" style={{ viewTransitionName: "site-header" }}>
        <div className="wrap flex h-[72px] items-center gap-3 sm:gap-6">
          <Link href="/today" aria-label="Legislative Analysis, Today"><Wordmark compact /></Link>
          <nav aria-label="Primary" className="ml-auto hidden h-full items-center gap-6 md:flex">
            {center && (
              <Link href="/constituent-center"
                className="band band-forest hidden h-11 items-center px-4 text-base font-semibold whitespace-nowrap transition-colors hover:bg-forest-deep xl:flex">
                Constituent Center
              </Link>
            )}
            {work.map((i) => barLink(i))}
            <MoreMenu items={research} pathname={pathname} />
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-4 md:ml-0">
            <SearchButton />
            <button type="button" onClick={() => setOpen(true)} aria-expanded={open}
              className="flex h-10 items-center gap-1.5 text-sm font-semibold text-ink transition-colors hover:text-ink-2 md:hidden">
              <Menu aria-hidden className="size-5" strokeWidth={1.75} />
              Menu
            </button>
          </div>
        </div>
      </header>

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Menu" className="band fixed inset-0 z-50 overflow-y-auto">
          <div className="wrap relative flex h-[72px] items-center justify-between">
            <Link href="/today" aria-label="Legislative Analysis, Today"><Wordmark /></Link>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" autoFocus
              className="grid size-9 place-items-center text-ink transition-colors hover:text-ink-2">
              <X aria-hidden className="size-6" strokeWidth={1.5} />
            </button>
          </div>
          <div className="wrap relative grid gap-x-16 gap-y-10 pt-8 pb-16 sm:grid-cols-2">
            {[
              { title: "Work", items: work },
              { title: "Research", items: research },
            ].map((g) => (
              <nav key={g.title} aria-label={g.title}>
                <p className="kicker text-ink-3">{g.title}</p>
                <ul className="mt-4">
                  {g.items.map((i) => (
                    <li key={i.href}>
                      <Link href={i.href} onClick={() => setOpen(false)} aria-current={isActive(pathname, i.href) ? "page" : undefined}
                        className={cn("display flex items-baseline gap-3 py-1.5 text-2xl font-medium transition-colors",
                        isActive(pathname, i.href) ? "text-chalk" : "text-ink hover:text-ink-2")}>
                        {i.label}
                        {i.count ? <span className="font-sans text-sm font-normal text-ink-3 tabular">{i.count}</span> : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
            <nav aria-label="Office" className="border-t border-line pt-6 sm:col-span-2">
              {center && (
                <Link href="/constituent-center" onClick={() => setOpen(false)} className="display mb-4 block text-2xl font-medium text-chalk">
                  Constituent Center
                </Link>
              )}
              <ul className="flex flex-wrap gap-x-8 gap-y-2">
                {office_.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href} onClick={() => setOpen(false)} className="text-sm text-ink-2 transition-colors hover:text-ink">
                      {i.label}
                      {i.count ? <span className="ml-1.5 font-semibold text-ink tabular">{i.count}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

export function Footer() {
  return (
    <footer className="band no-print mt-auto">
      <div className="wrap py-10">
        <div className="flex flex-wrap items-center justify-between gap-x-10 gap-y-5">
          <Wordmark />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2 text-sm text-ink-2">
            {[
              ["/settings", "Settings"],
              ["/team", "Team"],
              ["/help", "Help"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="transition-colors hover:text-ink">{label}</Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
