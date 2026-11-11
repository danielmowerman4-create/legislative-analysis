import { Search } from "lucide-react";
import { cn, Input } from "@/components/ui";
import { FilterForm } from "@/components/filter-form";

export function BillSearch({ value, keep, className }: { value?: string; keep?: Record<string, string | undefined>; className?: string }) {
  return (
    <FilterForm action="/bills" role="search" className={cn("flex", className)}>
      {Object.entries(keep ?? {}).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="relative flex min-w-0 flex-1 items-center">
        <span className="sr-only">Find a bill</span>
        <Search aria-hidden className="pointer-events-none absolute left-3.5 size-5 text-ink-3 sm:left-4" strokeWidth={1.75} />
        <Input solid name="q" type="search" defaultValue={value} placeholder="Bill number or topic" className="w-full pl-11 sm:pl-12" />
      </label>
      <button type="submit"
        className="h-14 shrink-0 bg-forest px-4 text-md font-semibold text-[oklch(0.985_0.004_150)] sm:px-7 transition-colors duration-150 hover:bg-forest-deep">
        Search
      </button>
    </FilterForm>
  );
}
