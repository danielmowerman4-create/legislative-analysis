import type { Metadata } from "next";
import { Download } from "lucide-react";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { POSITION_LABEL, PRIORITY_LABEL, sessionState, trackedReport } from "@/server/services/legislation";
import type { BillPosition } from "@/server/db/schema";
import { STATUS_LABEL } from "@/server/legislation/normalize";
import { ActionLink, cn, Notice, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { FilterForm } from "@/components/filter-form";
import { BillNumber } from "@/components/bills";
import { dateOnly, eventTime, shortDate } from "@/lib/format";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ position?: string; priority?: string }> }) {
  const { ctx, org } = await requireOffice();
  if (!can(ctx, "reports.read")) return <div className="wrap py-10"><Notice title="You do not have access to reports." /></div>;
  const sp = await searchParams;
  const [rows, session] = await orNotFound(Promise.all([trackedReport(ctx, sp), sessionState(ctx)]));
  const closed = session?.closed ?? false;
  const positions = (Object.keys(POSITION_LABEL) as BillPosition[]).filter((p) => rows.some((r) => r.position === p));
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => Boolean(e[1]))).toString();

  return (
    <>
      <PageHeader title="Reports" meta={`${rows.length} tracked ${rows.length === 1 ? "bill" : "bills"}`} actions={
        <span className="no-print flex flex-wrap items-center gap-x-7 gap-y-2">
          <PrintButton />
          <ActionLink plain href={`/api/export/tracked${qs ? `?${qs}` : ""}`} icon={Download}>Download CSV</ActionLink>
        </span>
      }>
        <FilterForm action="/reports" className="no-print flex flex-wrap items-center justify-center gap-x-6 gap-y-3 pb-7">
          <Select name="position" defaultValue={sp.position ?? ""} aria-label="Position" className="w-44">
            <option value="">All positions</option>
            {Object.entries(POSITION_LABEL).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </Select>
          <Select name="priority" defaultValue={sp.priority ?? ""} aria-label="Priority" className="w-44">
            <option value="">All priorities</option>
            {Object.entries(PRIORITY_LABEL).map(([k, l]) => (
              <option key={k} value={k}>{l} priority</option>
            ))}
          </Select>
        </FilterForm>
      </PageHeader>

      <article className="wrap py-10 lg:py-14 print:p-0">
        <h2 className="display border-b-2 border-ink pb-3 text-2xl text-ink">Tracked bills for {org.name}, {dateOnly(new Date())}</h2>
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-ink-3">No tracked bills match.</p>
        ) : (
          positions.map((p) => {
            const list = rows.filter((r) => r.position === p);
            return (
              <section key={p} className="mt-10">
                <h3 className="rail-title mb-3 text-lg text-ink">
                  {POSITION_LABEL[p]} <span className="tabular font-sans text-sm font-normal text-ink-3">{list.length}</span>
                </h3>
                <Table className="table-fixed">
                  <thead>
                    <tr>
                      <Th className="w-[34%]">Bill</Th>
                      <Th className={cn("hidden sm:table-cell", closed ? "w-[230px]" : "w-[130px]")}>{closed ? "Result" : "Status"}</Th>
                      <Th className="hidden md:table-cell print:table-cell">Last action</Th>
                      {!closed && <Th className="w-[150px]">Next hearing</Th>}
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={r.id} className="break-inside-avoid align-top">
                        <Td className="py-3 align-top">
                          <BillNumber identifier={r.identifier} />
                          <span className="mt-0.5 block font-display text-base font-medium text-ink">{r.title}</span>
                          {r.priority === "high" && <span className="mt-0.5 block text-sm text-warn-ink">High priority</span>}
                        </Td>
                        <Td className="hidden py-3 align-top text-ink sm:table-cell">
                          {closed ? (r.statusText ?? STATUS_LABEL[r.status]) : STATUS_LABEL[r.status]}
                        </Td>
                        <Td className="hidden py-3 align-top text-ink-2 md:table-cell print:table-cell">
                          {r.lastActionText} <span className="tabular whitespace-nowrap text-ink-3">{shortDate(r.lastActionAt)}</span>
                        </Td>
                        {!closed && <Td className="tabular py-3 align-top">{r.nextEvent ? eventTime(r.nextEvent) : "None scheduled"}</Td>}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </section>
            );
          })
        )}
      </article>
    </>
  );
}
