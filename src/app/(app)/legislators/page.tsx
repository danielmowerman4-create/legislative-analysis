import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { listLegislators } from "@/server/services/legislation";
import { EmptyState, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { CHAMBER } from "@/components/bills";
import { FilterForm } from "@/components/filter-form";

export const metadata: Metadata = { title: "Legislators" };

type LegislatorsPageProps = { searchParams: Promise<{ chamber?: string; party?: string; q?: string }> };

export default async function LegislatorsPage({ searchParams }: LegislatorsPageProps) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const rows = await orNotFound(listLegislators(ctx, sp));
  return (
    <>
      <PageHeader title="Legislators" meta={`${rows.length} members`} />
      <div>
        <div className="wrap py-3">
        <FilterForm action="/legislators" className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="relative flex min-w-48 flex-[1_1_100%] items-center sm:flex-[1_1_240px]">
            <span className="sr-only">Name or district</span>
            <input
              name="q"
              type="search"
              defaultValue={sp.q}
              placeholder="Name or district"
              className="h-10 w-full border-0 border-b border-line-strong bg-transparent pr-7 text-sm text-ink placeholder:text-ink-3 hover:border-ink focus:border-ink focus:shadow-[0_1px_0_0_var(--text)] focus:outline-none"
            />
            <Search aria-hidden className="pointer-events-none absolute right-0 size-4 text-ink-3" strokeWidth={1.75} />
          </label>
          <Select name="chamber" defaultValue={sp.chamber ?? ""} aria-label="Chamber" className="flex-1 sm:w-40 sm:flex-none">
            <option value="">Both chambers</option>
            <option value="lower">House</option>
            <option value="upper">Senate</option>
          </Select>
          <Select name="party" defaultValue={sp.party ?? ""} aria-label="Party" className="flex-1 sm:w-40 sm:flex-none">
            <option value="">Any party</option>
            <option value="R">Republican</option>
            <option value="D">Democrat</option>
          </Select>
          <button type="submit" className="sr-only">Search</button>
        </FilterForm>
        </div>
      </div>
      <div className="wrap pt-8 pb-14">
        {rows.length === 0 ? (
          <EmptyState title="No legislators match." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Party</Th>
                <Th className="hidden sm:table-cell">Chamber</Th>
                <Th align="right">District</Th>
                <Th align="right" className="hidden md:table-cell">Bills led</Th>
                <Th align="right" className="hidden lg:table-cell">Co-sponsored</Th>
                <Th align="right" className="hidden md:table-cell">Became law</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <Link href={`/legislators/${l.id}`}
                      className="font-display text-md font-medium text-ink decoration-rule underline-offset-4 hover:underline">
                      {l.name}
                    </Link>
                  </Td>
                  <Td>
                    <span className={l.party === "R" ? "text-party-r" : l.party === "D" ? "text-party-d" : "text-ink-2"}>
                      <span className="sm:hidden">{l.party}</span>
                      <span className="hidden sm:inline">{l.party === "R" ? "Republican" : l.party === "D" ? "Democrat" : (l.party ?? "")}</span>
                    </span>
                  </Td>
                  <Td className="hidden text-ink-2 sm:table-cell">{l.chamber ? (CHAMBER[l.chamber] ?? l.chamber) : ""}</Td>
                  <Td align="right">{l.district}</Td>
                  <Td align="right" className={`hidden md:table-cell ${l.authored ? "font-semibold text-ink" : "text-ink-3"}`}>{l.authored}</Td>
                  <Td align="right" className={`hidden lg:table-cell ${l.cosponsored ? "text-ink" : "text-ink-3"}`}>{l.cosponsored}</Td>
                  <Td align="right" className={`hidden md:table-cell ${l.enacted ? "font-semibold text-ok" : "text-ink-3"}`}>{l.enacted}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
