"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, LogOut } from "lucide-react";
import { cn } from "@/components/ui";

type UserMenuProps = { name: string; email: string; offices: { id: string; name: string }[]; activeOrgId: string; logout: () => Promise<void>;
  switchOffice: (orgId: string) => Promise<void> };

export function UserMenu({ name, email, offices, activeOrgId, logout, switchOffice }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        className="flex h-9 items-center gap-1.5 text-xs text-ink-2 transition-colors hover:text-ink">
        {name}
        <ChevronDown aria-hidden className="size-4 text-ink-3" />
      </button>
      {open && (
        <div role="menu" className="paper absolute top-full right-0 z-40 w-72 py-1.5 shadow-pop">
          <div className="border-b border-line px-4 py-2.5">
            <p className="truncate text-sm font-semibold text-ink">{name}</p>
            <p className="truncate text-sm text-ink-3">{email}</p>
          </div>
          {offices.length > 1 && (
            <div className="border-b border-line py-1">
              <p className="kicker px-4 py-1 text-ink-3">Office</p>
              {offices.map((o) => (
                <button key={o.id} role="menuitemradio" aria-checked={o.id === activeOrgId} onClick={() => switchOffice(o.id)}
                  className={cn("block w-full px-4 py-2 text-left text-sm hover:bg-surface-2", o.id === activeOrgId ? "font-semibold text-ink" : "text-ink-2")}>
                  {o.name}
                </button>
              ))}
            </div>
          )}
          {[
            ["/settings", "Settings"],
            ["/team", "Team"],
            ["/help", "Help"],
          ].map(([href, label]) => (
            <Link key={href} role="menuitem" href={href} onClick={() => setOpen(false)}
              className="block px-4 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              {label}
            </Link>
          ))}
          <a role="menuitem" href="/account/mfa" className="block px-4 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">Two-step verification</a>
          <form action={logout}>
            <button role="menuitem" type="submit"
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">
              <LogOut aria-hidden className="size-4" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
