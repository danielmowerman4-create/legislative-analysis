import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { billCorrespondence } from "@/server/services/center";
import { BILL_REQUEST_LABEL, type BillRequestKey } from "@/server/classification/categories";
import { BackLink, Block, DistrictWord, mailHref, Marked, ROOT } from "@/components/center/parts";
import { ActionLink, Status } from "@/components/ui";
import { shortDate } from "@/lib/format";

const PAGE = 100;

const STANCE: Record<string, string> = { support: "Support", oppose: "Oppose", mixed: "Mixed", neutral: "Asks about it", unclear: "Unclear" };

type BillMailPageProps = { params: Promise<{ reference: string }>; searchParams: Promise<{ page?: string }> };

export default async function BillMailPage({ params, searchParams }: BillMailPageProps) {
  const { ctx } = await requireCenter();
  const { reference } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const d = await billCorrespondence(ctx, decodeURIComponent(reference), { limit: PAGE, offset: (page - 1) * PAGE });
  if (!d.people) notFound();
  const href = (p: number) => `${ROOT}/topics/${encodeURIComponent(d.reference)}${p > 1 ? `?page=${p}` : ""}`;
  const requests = Object.entries(d.requests).sort((a, b) => b[1] - a[1]);
  return (
    <div className="pt-6">
      <BackLink href={`${ROOT}/topics`}>Topics</BackLink>
      <h1 className="anchor mt-4 text-[60px] text-ink lg:text-[96px]">{d.reference}</h1>
      {d.title && <p className="display mt-2 max-w-[34ch] text-[26px] text-ink">{d.title}</p>}
      <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3 text-base text-ink">
        {[
          ["People", d.people],
          ["In district", d.inDistrict],
          ["Support", d.positions.support ?? 0],
          ["Oppose", d.positions.oppose ?? 0],
          ["Other", d.people - (d.positions.support ?? 0) - (d.positions.oppose ?? 0)],
        ].map(([label, n]) => (
          <div key={label}><dt className="text-sm text-ink-2">{label}</dt><dd className="rail-title text-[40px] tabular">{n}</dd></div>
        ))}
      </dl>
      {d.billId && (
        <Link href={`/bills/${d.billId}`}
          className="mt-5 inline-block text-base text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
          Open this bill
        </Link>
      )}

      {requests.length > 0 && (
        <Block title="What they want done">
          <ul className="text-lg text-ink">
            {requests.map(([key, n]) => (
              <li key={key} className="flex max-w-md justify-between border-b border-line py-2">
                <span>{BILL_REQUEST_LABEL[key as BillRequestKey]}</span>
                <span className="tabular">{n}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Who wrote">
        <ul>
          {d.letters.map((l) => (
            <li key={l.messageId} className="grid gap-x-10 gap-y-2 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_230px]">
              <div className="min-w-0">
                <Link href={mailHref(l.messageId)} className="text-lg font-semibold text-ink transition-colors hover:text-ink-2">{l.name}</Link>
                {l.quote && <p className="mt-1.5 text-md text-ink"><Marked>{l.quote}</Marked></p>}
              </div>
              <div className="text-sm text-ink-2">
                <Status tone={l.position === "oppose" ? "danger" : l.position === "support" ? "ok" : "neutral"}>{STANCE[l.position] ?? l.position}</Status>
                {l.request && <p>{BILL_REQUEST_LABEL[l.request]}</p>}
                <p>
                  <DistrictWord status={l.districtStatus} />
                </p>
                {l.formLetter && <p>Form letter</p>}
                <p>{shortDate(l.receivedAt)}</p>
              </div>
            </li>
          ))}
        </ul>
        {(page > 1 || d.hasMore) && (
          <div className="mt-6 flex gap-6">
            {page > 1 && <ActionLink href={href(page - 1)}>Previous</ActionLink>}
            {d.hasMore && <ActionLink href={href(page + 1)}>Next</ActionLink>}
          </div>
        )}
      </Block>
    </div>
  );
}
