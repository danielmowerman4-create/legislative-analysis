import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { scorecards, type ScorecardRow } from "@/server/services/tools";
import { ActionLink, cn, EmptyState, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { Segmented } from "@/components/ui/blocks";
import { CHAMBER } from "@/components/bills";
import { FilterForm } from "@/components/filter-form";

export const metadata: Metadata = { title: "Scorecards" };

const SORTS = { allies: "Allies first", opponents: "Opponents first", partners: "Co-sponsors", name: "Name" } as const;
type Sort = keyof typeof SORTS;

const compare: Record<Sort, (a: ScorecardRow, b: ScorecardRow) => number> = {
  allies: (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.with - a.with || a.name.localeCompare(b.name),
  opponents: (a, b) => (a.score ?? 101) - (b.score ?? 101) || b.against - a.against || a.name.localeCompare(b.name),
  partners: (a, b) => b.partners - a.partners || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

export default async function ScorecardsPage({ searchParams }: { searchParams: Promise<{ sort?: string; chamber?: string; party?: string }> }) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const { rows, rollCalls, bills } = await scorecards(ctx);
  const noVotes = rollCalls === 0;
  const sort = (sp.sort && Object.hasOwn(SORTS, sp.sort) ? sp.sort : noVotes ? "partners" : "allies") as Sort;
  const shown = rows.filter((r) => (!sp.chamber || r.chamber === sp.chamber) && (!sp.party || (r.party ?? "").toUpperCase().startsWith(sp.party)))
    .sort(compare[sort]);
  const href = (s: Sort) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ chamber: sp.chamber, party: sp.party, sort: s === "allies" ? undefined : s })) if (v) p.set(k, v);
    const qs = p.toString();
    return `/scorecards${qs ? `?${qs}` : ""}`;
  };
  const meta = noVotes ? "Co-sponsors of your office's bills"
    : `${rollCalls} passage and committee ${rollCalls === 1 ? "vote" : "votes"} on ${bills} ${bills === 1 ? "bill" : "bills"} with your position`;

  return (
    <>
      <PageHeader title="Scorecards" meta={meta}>
        {!noVotes && (
          <div className="pb-7">
            <Segmented center label="Sort" current={sort} items={(Object.keys(SORTS) as Sort[]).map((k) => ({ key: k, label: SORTS[k], href: href(k) }))} />
          </div>
        )}
      </PageHeader>
      <div>
        <div className="wrap py-3">
        <FilterForm action="/scorecards" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
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
        </FilterForm>
        </div>
      </div>
      <div className="wrap pt-8 pb-14">
        {noVotes && rows.length > 0 ? (
          <>
            <p className="max-w-[68ch] text-base text-ink-2">
              No passage votes are loaded for bills with your position, so members cannot be scored yet. Co-sponsorship is shown instead.
            </p>
            <Table className="mt-6">
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th align="right">Shared bills</Th>
                </tr>
              </thead>
              <tbody>
                {shown
                  .filter((r) => r.partners > 0)
                  .map((r) => (
                    <tr key={r.id}><MemberCell r={r} /><Td align="right" className="font-semibold text-ink">{r.partners}</Td></tr>
                  ))}
                {shown.every((r) => r.partners === 0) && (
                  <tr>
                    <Td colSpan={2} className="text-ink-3">No members match.</Td>
                  </tr>
                )}
              </tbody>
            </Table>
          </>
        ) : rows.length === 0 ? (
          <EmptyState title="No voting records to score yet." action={<ActionLink href="/tracked">Set positions on tracked bills</ActionLink>}>
            Scores appear once your office has a Support or Oppose position on a bill with a recorded vote.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Member</Th>
                <Th align="right">With you</Th>
                <Th align="right" className="hidden md:table-cell">Against</Th>
                <Th align="right" className="hidden md:table-cell">Missed</Th>
                <Th align="right">Score</Th>
                <Th align="right" className="hidden lg:table-cell">Co-sponsors with you</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <MemberCell r={r} />
                  <Td align="right">{r.counted ? `${r.with} of ${r.counted}` : <span className="text-ink-3">No votes</span>}</Td>
                  <Td align="right" className={cn("hidden md:table-cell", r.against ? "text-oppose" : "text-ink-3")}>{r.against}</Td>
                  <Td align="right" className={cn("hidden md:table-cell", r.missed ? "text-ink" : "text-ink-3")}>{r.missed}</Td>
                  <Td align="right">
                    {r.score === null ? (
                      <span className="whitespace-nowrap text-ink-3">Too few votes</span>
                    ) : (
                      <span className="flex items-center justify-end gap-3">
                        <span aria-hidden className="hidden h-1 w-24 bg-surface-3 sm:block">
                          <span className="block h-1 bg-accent" style={{ width: `${r.score}%` }} />
                        </span>
                        <span className="w-11 font-semibold text-ink">{r.score}%</span>
                      </span>
                    )}
                  </Td>
                  <Td align="right" className={cn("hidden lg:table-cell", r.partners ? "text-ink" : "text-ink-3")}>{r.partners}</Td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <Td colSpan={6} className="text-ink-3">No members match.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}

function MemberCell({ r }: { r: ScorecardRow }) {
  return (
    <Td>
      <Link href={`/legislators/${r.id}`} className="font-display text-base font-medium text-ink decoration-rule underline-offset-4 hover:underline">
        {r.name}
      </Link>
      <span className="tabular block text-sm text-ink-2">
        <span className={cn("font-semibold", r.party === "R" ? "text-party-r" : r.party === "D" ? "text-party-d" : "")}>{r.party}</span>{" "}
        {r.chamber ? CHAMBER[r.chamber] : ""} {r.district}
      </span>
    </Td>
  );
}
