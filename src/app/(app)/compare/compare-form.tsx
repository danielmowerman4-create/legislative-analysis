"use client";

import { useRouter } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import { BillPicker } from "../bills/controls";

type Picked = { id: string; identifier: string; title: string; session: string } | null;

export function CompareForm({ a, b }: { a: Picked; b: Picked }) {
  const router = useRouter();
  const go = (left: Picked, right: Picked) => {
    const p = new URLSearchParams();
    if (left) p.set("a", left.id);
    if (right) p.set("b", right.id);
    router.push(`/compare?${p}`);
  };
  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:gap-6">
      <div className="min-w-0 flex-1"><BillPicker solid label="1. First bill" initial={a} exclude={b ? [b.id] : []} onPick={(x) => go(x, b)} /></div>
      {a && b && (
        <button type="button" onClick={() => go(b, a)} title="Swap the two bills"
          className="flex h-12 shrink-0 items-center gap-2 self-start text-sm font-semibold text-ink transition-colors hover:text-ink-2 md:self-end">
          <ArrowLeftRight aria-hidden className="size-5" strokeWidth={1.5} />
          Swap
        </button>
      )}
      <div className="min-w-0 flex-1"><BillPicker solid label="2. Second bill" initial={b} exclude={a ? [a.id] : []} onPick={(x) => go(a, x)} /></div>
    </div>
  );
}
