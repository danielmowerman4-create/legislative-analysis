import type { Metadata } from "next";
import Link from "next/link";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import {
  BILL_VIEWS,
  billFilterOptions,
  CLOSED_SESSION_VIEWS,
  legislativeFreshness,
  listBills,
  OPEN_SESSION_VIEWS,
  sessionState,
  type BillFilters,
  type BillSort,
  type BillView,
} from "@/server/services/legislation";
import { STATUS_LABEL } from "@/server/legislation/normalize";
import { citationLabel } from "@/server/legislation/related";
import { ActionLink, EmptyState, Notice, PageHeader, Select } from "@/components/ui";
import { Freshness, Tabs } from "@/components/ui/blocks";
import { BillList, PartyMark, PositionMark, PriorityMark } from "@/components/bills";
import { FilterForm } from "@/components/filter-form";
import { MoreFilters } from "@/components/more-filters";
import { BillSearch } from "@/components/bill-search";
import { PositionButtons } from "./controls";

export const metadata: Metadata = { title: "Bills" };

type SP = Record<string, string | undefined>;
const PAGE = 50;
const FILTER_KEYS = ["q", "session", "chamber", "status", "committee", "subject", "code", "sponsor", "position"] as const;

export default async function BillsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const view = (sp.view && Object.hasOwn(BILL_VIEWS, sp.view) ? sp.view : "all") as BillView;
  const page = Math.max(1, Number(sp.page) || 1);
  const filters: BillFilters = { view, q: sp.q, session: sp.session, chamber: sp.chamber, status: sp.status, committee: sp.committee, subject: sp.subject,
    code: sp.code, sponsor: sp.sponsor, position: sp.position, sort: sp.sort as BillSort | undefined, limit: PAGE, offset: (page - 1) * PAGE };
  const [r, opts, fresh,
    session] = await orNotFound(Promise.all([listBills(ctx, filters), billFilterOptions(ctx), legislativeFreshness(ctx), sessionState(ctx)]));
  const views = session?.closed ? CLOSED_SESSION_VIEWS : OPEN_SESSION_VIEWS;
  const canTrack = can(ctx, "legislation.track");
  const sorts: [string, string][] = [["introduced", "Sort: newest"], ["number", "Sort: bill number"]];
  if (!session?.closed) sorts.unshift(["hearing", "Sort: next hearing"]);

  const href = (patch: SP) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, page: undefined, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return `/bills${s ? `?${s}` : ""}`;
  };
  const active = FILTER_KEYS.filter((k) => sp[k]);
  const cleared = href(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));

  return (
    <>
      <PageHeader title="Bills" meta={`${r.total.toLocaleString()} ${r.total === 1 ? "bill" : "bills"}`} actions={
        <>
          <Freshness at={fresh.lastOk?.finishedAt} stale={fresh.stale} label="Checked with the state" snapshotAt={fresh.snapshotAt} />
          <FilterForm action="/bills">
            {Object.entries(sp).map(([k, v]) => (k !== "sort" && k !== "page" && v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
            <Filter label="Sort" name="sort" value={sp.sort} width="w-44" all="Sort: latest action" options={sorts} />
          </FilterForm>
        </>
      }>
        <BillSearch
          value={sp.q}
          keep={{
            view: view === "all" ? undefined : view,
            session: sp.session, chamber: sp.chamber, status: sp.status, committee: sp.committee,
            subject: sp.subject, code: sp.code, sponsor: sp.sponsor, position: sp.position, sort: sp.sort,
          }}
          className="mx-auto mb-6 max-w-[720px]"
        />
        <Tabs name="bills" className="flex-wrap justify-center gap-x-6 gap-y-1 md:gap-x-7" current={view}
          items={views.map((k) => ({ key: k, label: BILL_VIEWS[k], href: href({ view: k === "all" ? undefined : k }) }))} />
      </PageHeader>

      <div>
        <div className="wrap py-3">
        <FilterForm action="/bills" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
          {view !== "all" && <input type="hidden" name="view" value={view} />}
          {sp.code && <input type="hidden" name="code" value={sp.code} />}
          {sp.sponsor && <input type="hidden" name="sponsor" value={sp.sponsor} />}
          {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
          {sp.q && <input type="hidden" name="q" value={sp.q} />}
          <Filter label="Status" name="status" value={sp.status} all="Any status" options={Object.entries(STATUS_LABEL).filter(([k]) => k !== "other")}
            width="flex-[1_1_140px] sm:w-40 sm:flex-none" />
          <Filter label="Chamber" name="chamber" value={sp.chamber} all="Both chambers" options={[["lower", "House"], ["upper", "Senate"]]}
            width="flex-[1_1_140px] sm:w-36 sm:flex-none" />
          <MoreFilters active={[sp.session, sp.committee, sp.subject, sp.position].filter(Boolean).length}>
            <Filter label="Session" name="session" value={sp.session} all="All sessions" options={opts.sessions.map((s) => [s.id, s.identifier])} block />
            <Filter label="Committee" name="committee" value={sp.committee} all="Any committee" options={opts.committees.map((c) => [c.id, c.name])} block />
            <Filter label="Subject" name="subject" value={sp.subject} all="Any subject" options={opts.subjects.map((s) => [s, s])} block />
            <Filter label="Your position" name="position" value={sp.position} all="Any position"
              options={[["support", "Support"], ["oppose", "Oppose"], ["neutral", "Neutral"], ["watching", "Watching"]]} block />
          </MoreFilters>
          {active.length > 0 && (
            <Link href={cleared}
              className="flex h-10 items-center text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink">
              Clear
            </Link>
          )}
          <button type="submit" className="sr-only">Apply filters</button>
        </FilterForm>
        </div>
      </div>

      <div className="wrap">
        {sp.code && (
          <p className="mt-4 text-sm text-ink">
            Bills that change <span className="font-semibold">{citationLabel(sp.code)}</span>
            <Link href={href({ code: undefined })} className="ml-3 text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">Remove</Link>
          </p>
        )}

        {fresh.lastFailed && (
          <div className="mt-6">
            <Notice tone="danger" title="The last update from the legislative data source failed.">
              Bills below are from the last successful update.{" "}
              {can(ctx, "integrations.manage") ? "Details are in Settings." : "An administrator can check Settings."}
            </Notice>
          </div>
        )}
      </div>

      <div className="wrap pt-8 pb-14">
        {r.items.length === 0 ? (
          <EmptyState title={ !fresh.lastOk ? "No bills have been loaded for this state yet." : active.length ? "No bills match these filters."
            : `No bills in ${BILL_VIEWS[view]}.` } action={active.length ? <ActionLink href={cleared}>Clear filters</ActionLink> : undefined} />
        ) : (
          <BillList morph asideBelow closed={session?.closed} rows={r.items.map((b) => ({
            id: b.id,
            identifier: b.identifier,
            title: b.title,
            status: b.status,
            billType: b.billType,
            sub: (
              <>
                {b.primarySponsor}
                {b.primaryParty && (
                  <>
                    {" "}
                    <PartyMark party={b.primaryParty} />
                  </>
                )}
                {b.committee && b.committee !== b.primarySponsor ? ` · ${b.committee}` : ""}
              </>
            ),
            lastActionAt: b.lastActionAt,
            lastActionText: b.lastActionText,
            nextEvent: b.nextEvent,
            result: b.statusText,
            aside: (
              <span className="flex items-center gap-2.5">
                <PriorityMark priority={b.priority} />
                {canTrack ? <PositionButtons billId={b.id} identifier={b.identifier} position={b.position} /> : <PositionMark position={b.position} />}
              </span>
            ),
          }))} />
        )}
        {(page > 1 || r.hasMore) && (
          <nav aria-label="Pages" className="flex items-center justify-between pt-6 text-sm">
            <span className="tabular text-ink-3">{(page - 1) * PAGE + 1}–{(page - 1) * PAGE + r.items.length} of {r.total.toLocaleString()}</span>
            <span className="flex gap-8">
              {page > 1 && <ActionLink href={href({ page: String(page - 1) })}>Previous</ActionLink>}
              {r.hasMore && <ActionLink href={href({ page: String(page + 1) })}>Next</ActionLink>}
            </span>
          </nav>
        )}
      </div>
    </>
  );
}

type FilterProps = { label: string; name: string; value?: string; options: [string, string][]; all: string; block?: boolean; width?: string };

function Filter({ label, name, value, options, all, block, width }: FilterProps) {
  return (
    <Select name={name} defaultValue={value ?? ""} aria-label={label} className={block ? "w-full" : (width ?? "w-40")}>
      <option value="">{all}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </Select>
  );
}
