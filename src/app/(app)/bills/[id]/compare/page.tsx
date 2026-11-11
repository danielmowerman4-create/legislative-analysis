import type { Metadata } from "next";
import Link from "next/link";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { compareBillVersions, getBillDetail } from "@/server/services/legislation";
import { ActionLink, Breadcrumbs, Notice, PageHeader, Select } from "@/components/ui";
import { FilterForm } from "@/components/filter-form";
import { ArrowRight } from "lucide-react";
import { ComparisonView } from "@/components/comparison";
import { dateOnly } from "@/lib/format";

export const metadata: Metadata = { title: "Compare versions" };

type CompareVersionsPageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string; layout?: string; page?: string }> };

export default async function CompareVersionsPage({ params, searchParams }: CompareVersionsPageProps) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const sp = await searchParams;
  const detail = await orNotFound(getBillDetail(ctx, id));
  const versions = detail.versions;
  const from = sp.from ?? versions[versions.length - 2]?.id;
  const to = sp.to ?? versions[versions.length - 1]?.id;
  const r = from && to ? await orNotFound(compareBillVersions(ctx, id, from, to)) : null;
  const layout = sp.layout === "inline" ? "inline" : "side";
  const label = (vid: string | undefined) => versions.find((v) => v.id === vid)?.label ?? "";
  const base = `/bills/${id}/compare?from=${from}&to=${to}`;
  const versionOptions = versions.map((v) => <option key={v.id} value={v.id}>{v.label} ({dateOnly(v.versionDate)})</option>);

  return (
    <>
      <PageHeader title={detail.bill.title} meta={`${detail.bill.identifier} versions`} crumbs={
        <Breadcrumbs items={[{ label: "Bills", href: "/bills" }, { label: detail.bill.identifier, href: `/bills/${id}` }, { label: "Compare versions" }]} />
      }>
        {versions.length >= 2 && (
          <FilterForm action={`/bills/${id}/compare`}
            className="flex flex-col gap-4 pb-8 md:flex-row md:flex-wrap md:items-center md:justify-center md:gap-x-8">
            <Select name="from" defaultValue={from} aria-label="Earlier version" className="md:w-72">{versionOptions}</Select>
            <ArrowRight aria-hidden className="hidden size-5 shrink-0 text-ink-3 md:block" strokeWidth={1.5} />
            <Select name="to" defaultValue={to} aria-label="Later version" className="md:w-72">{versionOptions}</Select>
            {layout === "inline" && <input type="hidden" name="layout" value="inline" />}
            <ActionLink href={`/compare?a=${id}`}>Compare with a different bill</ActionLink>
          </FilterForm>
        )}
      </PageHeader>
      <div className="wrap py-10 lg:py-14">
        {!r ? (
          <Notice title="This bill has fewer than two versions on record, so there is nothing to compare yet.">
            <Link href={`/compare?a=${id}`} className="font-semibold text-ink underline decoration-rule underline-offset-4">
              Compare it with a different bill
            </Link>
          </Notice>
        ) : !r.comparison ? (
          <Notice title={`Text is not available for: ${r.missing.join(", ")}.`}>The source has not published readable text for that version.</Notice>
        ) : (
          <ComparisonView comparison={r.comparison} leftLabel={label(from)} rightLabel={label(to)} layout={layout}
            layoutHref={(l) => `${base}${l === "inline" ? "&layout=inline" : ""}`} page={Number(sp.page) || 1}
            pageHref={(n) => `${base}${layout === "inline" ? "&layout=inline" : ""}&page=${n}`} />
        )}
      </div>
    </>
  );
}
