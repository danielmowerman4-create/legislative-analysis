import type { Metadata } from "next";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { getBillDetail } from "@/server/services/legislation";
import { listTeam } from "@/server/services/offices";
import { Breadcrumbs, PageHeader } from "@/components/ui";
import { BillBrief } from "@/components/bill-brief";
import { dateOnly } from "@/lib/format";
import { PrintButton } from "../../../reports/print-button";

export const metadata: Metadata = { title: "Bill brief" };

export default async function BillBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, org } = await requireOffice();
  const { id } = await params;
  const [d, team] = await orNotFound(Promise.all([getBillDetail(ctx, id), listTeam(ctx)]));
  const assignee = team.find((m) => m.userId === d.tracking?.assignedTo)?.name ?? null;

  return (
    <>
      <PageHeader title={`${d.bill.identifier} brief`} meta="Bill brief" crumbs={<Breadcrumbs items={[{ label: "Bills", href: "/bills" },
        { label: d.bill.identifier, href: `/bills/${id}` }, { label: "Brief" }]} />} actions={<PrintButton />} />
      <article className="wrap py-8 lg:py-12 print:p-0">
        <h1 className="display hidden text-2xl text-ink print:block">Bill brief for {org.name}, {dateOnly(new Date())}</h1>
        <BillBrief d={d} full noRollCalls={d.votes.length === 0} assignee={assignee} />
      </article>
    </>
  );
}
