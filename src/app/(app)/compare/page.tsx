import type { Metadata } from "next";
import { requireOffice } from "@/server/auth/next";
import { compareBills, getBillDetail, relatedBills, trackedReport } from "@/server/services/legislation";
import { can } from "@/server/authz/context";
import { reasonText } from "@/server/legislation/related";
import { Notice, PageHeader, Select } from "@/components/ui";
import { FilterForm } from "@/components/filter-form";
import { ArrowRight } from "lucide-react";
import { BillLine, CHAMBER } from "@/components/bills";
import { Section, Segmented } from "@/components/ui/blocks";
import { ComparisonView } from "@/components/comparison";
import { BillCompare } from "@/components/bill-compare";
import { dateOnly } from "@/lib/format";
import { CompareForm } from "./compare-form";

export const metadata: Metadata = { title: "Compare bills" };

type SP = { a?: string; b?: string; av?: string; bv?: string; layout?: string; view?: string; page?: string };

export default async function ComparePage({ searchParams }: { searchParams: Promise<SP> }) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const load = async (id?: string) => {
    if (!id) return null;
    try {
      const d = await getBillDetail(ctx, id);
      return { id, identifier: d.bill.identifier, title: d.bill.title, session: d.session.identifier, status: d.bill.status, versions: d.versions, detail: d };
    } catch {
      return null;
    }
  };
  const [a, b] = await Promise.all([load(sp.a), load(sp.b)]);
  const layout = sp.layout === "inline" ? "inline" : "side";
  const wording = sp.view === "wording";
  const result = a && b && wording ? await compareBills(ctx, { billId: a.id, versionId: sp.av }, { billId: b.id, versionId: sp.bv }) : null;
  const connected = a && b && !wording ? (await relatedBills(ctx, a.id)).find((r) => r.id === b.id) : null;
  const suggestions = a && !b ? (await relatedBills(ctx, a.id)).filter((r) => r.id && r.group !== "more").slice(0, 8) : [];
  const tracked = !a && can(ctx, "reports.read") ? (await trackedReport(ctx)).slice(0, 10) : [];
  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) p.set(k, v);
    return `/compare?${p}`;
  };
  const picked = (x: typeof a) => x && { id: x.id, identifier: x.identifier, title: x.title, session: x.session };

  return (
    <>
      <PageHeader title="Compare" meta="What any two bills do, side by side">
        <div className="pb-8">
          <CompareForm a={picked(a)} b={picked(b)} />
          {a && b && (
            <div className="mt-5">
              <Segmented center label="Compare" showLabel={false} current={wording ? "wording" : "does"} items={[
                { key: "does", label: "What they do", href: qs({ view: undefined, page: undefined }) },
                { key: "wording", label: "Exact wording", href: qs({ view: "wording", page: undefined }) },
              ]} />
            </div>
          )}
          {a && b && result && (
            <FilterForm action="/compare" className="mt-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-center md:gap-8">
              <input type="hidden" name="a" value={a.id} />
              <input type="hidden" name="b" value={b.id} />
              <input type="hidden" name="view" value="wording" />
              {layout === "inline" && <input type="hidden" name="layout" value="inline" />}
              <VersionSelect name="av" label={`${a.identifier} version`} versions={a.versions} value={result.left.version?.id} />
              <ArrowRight aria-hidden className="hidden size-5 shrink-0 text-ink-3 md:mx-2.5 md:block" strokeWidth={1.5} />
              <VersionSelect name="bv" label={`${b.identifier} version`} versions={b.versions} value={result.right.version?.id} />
            </FilterForm>
          )}
        </div>
      </PageHeader>
      <div className="wrap">
        {!a && (
          <Section title="Start from a tracked bill">
            {tracked.length === 0 ? (
              <p className="border-y border-line py-5 text-sm text-ink-3">No tracked bills yet.</p>
            ) : (
              <ul className="flex flex-col">
                {tracked.map((t) => (
                  <BillLine key={t.id} href={qs({ a: t.id })} identifier={t.identifier} title={t.title} status={t.status} />
                ))}
              </ul>
            )}
          </Section>
        )}

        {a && !b && (
          <Section title={`Bills connected to ${a.identifier}`}>
            {suggestions.length === 0 ? (
              <p className="border-y border-line py-5 text-sm text-ink-3">
                No companions, earlier versions or bills changing the same code were found. Pick the second bill above.
              </p>
            ) : (
              <ul className="flex flex-col">
                {suggestions.map((r) => (
                  <BillLine key={r.id} href={qs({ b: r.id! })} identifier={r.identifier} title={r.title ?? r.identifier}
                    note={reasonText(r.reasons[0], r.chamber ? CHAMBER[r.chamber] : undefined)} />
                ))}
              </ul>
            )}
          </Section>
        )}

        {a && b && !wording && (
          <BillCompare a={a.detail} b={b.detail}
            connection={(connected?.reasons ?? []).map((x) => reasonText(x, connected?.chamber ? CHAMBER[connected.chamber] : undefined))} />
        )}

        {a && b && result && (
          <div className="py-10 lg:py-14">
            {!result.comparison ? (
              <Notice title={`Text is not available for: ${result.missing.join(", ")}.`}>The comparison needs published text for both bills.</Notice>
            ) : (
              <ComparisonView
                comparison={result.comparison}
                leftLabel={`${a.identifier} · ${result.left.version?.label ?? ""}`}
                rightLabel={`${b.identifier} · ${result.right.version?.label ?? ""}`}
                layout={layout}
                layoutHref={(l) => qs({ layout: l === "inline" ? "inline" : undefined, page: undefined })}
                page={Number(sp.page) || 1}
                pageHref={(n) => qs({ page: String(n) })}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

type VersionSelectProps = { name: string; label: string; versions: { id: string; label: string; versionDate: string | null }[]; value?: string };

function VersionSelect({ name, label, versions, value }: VersionSelectProps) {
  return (
    <Select name={name} defaultValue={value} aria-label={label} className="min-w-0 flex-1">
      {versions.map((v) => (
        <option key={v.id} value={v.id}>{label.split(" ").slice(0, 2).join(" ")}: {v.label} ({dateOnly(v.versionDate)})</option>
      ))}
    </Select>
  );
}
