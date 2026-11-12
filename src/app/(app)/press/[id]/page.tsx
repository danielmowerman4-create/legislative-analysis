import type { Metadata } from "next";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { getPress, PRESS_KIND_LABEL } from "@/server/services/press";
import type { PressGraphic } from "@/server/db/schema";
import { Breadcrumbs, PageHeader } from "@/components/ui";
import { Section } from "@/components/ui/blocks";
import { dateOnly } from "@/lib/format";
import { StatementEditor } from "../controls";
import { GraphicMaker } from "../graphic";

export const metadata: Metadata = { title: "Press" };

const CHAMBER_TITLE: Record<string, string> = { lower: "State Representative", upper: "State Senator" };
// The first quoted passage is the statement; the graphic starts from it.
const firstQuote = (body: string) => body.match(/"([^"]{20,400})"/)?.[1] ?? "";

export default async function PressItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const p = await orNotFound(getPress(ctx, id));
  const name = (p.office.legislatorName ?? p.office.name).replace(/^(Rep\.|Sen\.|Representative|Senator)\s+/i, "");
  const officeLine = [CHAMBER_TITLE[p.office.chamber], p.office.district ? `District ${p.office.district}` : null].filter(Boolean).join(", ");
  const quote = firstQuote(p.body);
  const start: PressGraphic = p.graphic ?? {
    layout: "type", size: "square", headline: p.bill ? p.bill.title : p.headline, statement: quote.startsWith("[") ? "" : quote,
    kicker: [name, officeLine].filter(Boolean).join("\n"), field: "#14264a", accent: "#b3282d",
  };
  const approved = p.status === "approved";
  return (
    <>
      <div className="no-print">
        <PageHeader title={p.headline} crumbs={<Breadcrumbs items={[{ label: "Press", href: "/press" }, { label: PRESS_KIND_LABEL[p.kind] }]} />}
          meta={[approved ? `Approved${p.approvedByName ? ` by ${p.approvedByName}` : ""}, ${dateOnly(p.approvedAt)}` : "Draft",
            p.aiGenerated ? "First draft written with AI" : null].filter(Boolean).join(" · ")} />
        <div className="wrap">
          <Section title="Statement" href={p.bill ? `/bills/${p.bill.id}` : undefined} linkLabel={p.bill?.identifier}>
            <StatementEditor key={`${p.updatedAt.getTime()}-${p.status}`} id={p.id} headline={p.headline} body={p.body} approved={approved}
              canEdit={can(ctx, "communications.draft")} canApprove={can(ctx, "communications.approve")} />
          </Section>
          <Section title="Graphic">
            <GraphicMaker id={p.id} start={start} canEdit={can(ctx, "communications.draft")}
              fileName={(p.bill?.identifier ?? p.headline).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "statement"} />
          </Section>
        </div>
      </div>
      <article className="wrap hidden py-10 print:block">
        <h1 className="display text-[30px] text-ink">{p.headline}</h1>
        <div className="letter mt-6 text-ink">{p.body}</div>
      </article>
    </>
  );
}
