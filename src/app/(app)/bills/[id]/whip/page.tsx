import type { Metadata } from "next";
import { Download } from "lucide-react";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { whipBoard } from "@/server/services/tools";
import { ActionLink, Breadcrumbs, PageHeader } from "@/components/ui";
import { Segmented } from "@/components/ui/blocks";
import type { WhipRule } from "@/lib/whip";
import { WhipBoard } from "./whip-board";

export const metadata: Metadata = { title: "Whip count" };

type WhipPageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ chamber?: string; need?: string }> };

export default async function WhipPage({ params, searchParams }: WhipPageProps) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const sp = await searchParams;
  const w = await orNotFound(whipBoard(ctx, id, { chamber: sp.chamber }));
  const rule: WhipRule = sp.need === "two_thirds" ? "two_thirds" : "majority";
  const href = (patch: { chamber?: string; need?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ chamber: w.chamber, need: sp.need, ...patch })) if (v) p.set(k, v);
    return `/bills/${id}/whip?${p}`;
  };

  return (
    <>
      <PageHeader
        compact
        title={w.bill.title}
        meta={`${w.bill.identifier} whip count`}
        crumbs={<Breadcrumbs items={[{ label: "Bills", href: "/bills" }, { label: w.bill.identifier, href: `/bills/${id}` }, { label: "Whip count" }]} />}
        actions={
          <ActionLink plain href={`/api/export/whip?bill=${id}&chamber=${w.chamber}`} icon={Download}>Download CSV</ActionLink>
        }
      >
        <div className="flex flex-wrap justify-center gap-x-12 gap-y-3 pb-7">
          <Segmented center label="Chamber" current={w.chamber}
            items={[{ key: "lower", label: "House", href: href({ chamber: "lower" }) }, { key: "upper", label: "Senate", href: href({ chamber: "upper" }) }]} />
          <Segmented center label="To pass" current={rule} items={[
            { key: "majority", label: "Majority", href: href({ need: undefined }) },
            { key: "two_thirds", label: "Two-thirds", href: href({ need: "two_thirds" }) },
          ]} />
        </div>
      </PageHeader>
      {/* A new chamber starts a fresh board. */}
      <WhipBoard key={w.chamber} billId={id} chamber={w.chamber} initial={w.rows} seats={w.seats} rule={rule} canEdit={can(ctx, "legislation.track")}
        officeId={w.officeMemberId} />
    </>
  );
}
