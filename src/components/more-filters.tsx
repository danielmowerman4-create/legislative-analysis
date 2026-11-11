"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/components/ui";

export function MoreFilters({ active, children }: { active: number; children: ReactNode }) {
  const [open, setOpen] = useState(active > 0);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-1.5 text-sm font-semibold whitespace-nowrap text-ink transition-colors hover:text-ink-2">
        More filters
        {active > 0 && <span className="tabular font-normal text-ink-3">{active}</span>}
        <ChevronDown aria-hidden className={cn("size-4 text-ink-3 transition-transform duration-200 ease-out-quart", open && "rotate-180")}
          strokeWidth={1.75} />
      </button>
      {open && <div className="grid basis-full gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>}
    </>
  );
}
