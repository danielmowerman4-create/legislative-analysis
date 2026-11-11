import type { Metadata } from "next";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { hearingPrep } from "@/server/services/tools";
import { Breadcrumbs, PageHeader, SepList } from "@/components/ui";
import { BillBrief } from "@/components/bill-brief";
import { dateOnly, eventTime, isDateOnly, timeOnly } from "@/lib/format";
import { PrintButton } from "../../../reports/print-button";

export const metadata: Metadata = { title: "Hearing prep sheet" };

export default async function PrepPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const { event, items } = await orNotFound(hearingPrep(ctx, id));
  const noRollCalls = items.every((d) => d.votes.length === 0);

  return (
    <>
      <PageHeader title={event.title} meta={eventTime(event.startsAt)}
        crumbs={<Breadcrumbs items={[{ label: "Calendar", href: "/calendar" }, { label: "Prep sheet" }]} />} actions={<PrintButton />} />
      <article className="wrap py-8 lg:py-12 print:p-0">
        <h1 className="display hidden text-2xl text-ink print:block">
          {event.title}, {dateOnly(event.startsAt)}
          {isDateOnly(event.startsAt) ? "" : `, ${timeOnly(event.startsAt)}`}
          {event.location ? `, ${event.location}` : ""}
        </h1>
        <SepList center className="no-print text-base text-ink-2">
          {event.location && <span>{event.location}</span>}
          <span className="tabular">{items.length} {items.length === 1 ? "bill" : "bills"} on the agenda</span>
          <span className="tabular">{items.filter((d) => d.tracking).length} tracked by your office</span>
        </SepList>

        {items.length === 0 && <p className="mt-8 border-y border-line py-5 text-sm text-ink-3">No bills are listed for this meeting.</p>}

        {items.map((d) => (
          <BillBrief key={d.bill.id} d={d} noRollCalls={noRollCalls} />
        ))}
      </article>
    </>
  );
}
