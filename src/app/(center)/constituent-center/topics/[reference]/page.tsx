import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { billCorrespondence, type BillSide } from "@/server/services/center";
import { billAnswers } from "@/server/services/bill-answers";
import { BILL_REQUEST_LABEL, type BillRequestKey } from "@/server/classification/categories";
import { AnswerSideButton } from "@/components/center/controls";
import { SplitBar, WeekBars, type Sides } from "@/components/center/graphs";
import { BackLink, Block, DistrictWord, mailHref, Marked, ROOT, StanceWord } from "@/components/center/parts";
import { ActionLink, cn } from "@/components/ui";
import { Tabs } from "@/components/ui/blocks";
import { shortDate } from "@/lib/format";

const PAGE = 100;
const SIDE_WORD: Record<BillSide, string> = { support: "Support", oppose: "Oppose", other: "Other" };
const SIDE_BAR: Record<BillSide, string> = { support: "bar-support", oppose: "bar-oppose", other: "bar-other" };
const sides = (p: Record<string, number>, people: number): Sides => {
  const support = p.support ?? 0;
  const oppose = p.oppose ?? 0;
  return { support, oppose, other: people - support - oppose };
};

type BillMailPageProps = { params: Promise<{ reference: string }>; searchParams: Promise<{ page?: string; side?: string }> };

export default async function BillMailPage({ params, searchParams }: BillMailPageProps) {
  const { ctx } = await requireCenter();
  const { reference } = await params;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const side = sp.side && Object.hasOwn(SIDE_WORD, sp.side) ? (sp.side as BillSide) : undefined;
  const d = await billCorrespondence(ctx, decodeURIComponent(reference), { limit: PAGE, offset: (page - 1) * PAGE, side });
  if (!d.people) notFound();
  const answers = can(ctx, "communications.draft") ? await billAnswers(ctx, d.reference) : null;
  const href = (patch: { page?: number; side?: BillSide | null }) => {
    const p = new URLSearchParams();
    const s = patch.side === undefined ? side : patch.side;
    if (s) p.set("side", s);
    if (patch.page && patch.page > 1) p.set("page", String(patch.page));
    const q = p.toString();
    return `${ROOT}/topics/${encodeURIComponent(d.reference)}${q ? `?${q}` : ""}`;
  };
  const requests = Object.entries(d.requests).sort((a, b) => b[1] - a[1]);
  const all = sides(d.positions, d.people);
  const district = sides(d.inDistrictSides, d.inDistrict);
  const facts: [string, number, BillSide?][] = [["People", d.people], ["In district", d.inDistrict], ["Support", all.support, "support"],
    ["Oppose", all.oppose, "oppose"], ["Other", all.other, "other"]];
  return (
    <div className="pt-6">
      <BackLink href={`${ROOT}/topics`}>Topics</BackLink>
      <h1 className="anchor mt-4 text-[60px] text-ink lg:text-[96px]">{d.reference}</h1>
      {d.title && <p className="display mt-2 max-w-[34ch] text-[26px] text-ink">{d.title}</p>}
      <dl className="mt-6 flex flex-wrap gap-x-10 gap-y-3 text-base text-ink">
        {facts.map(([label, n, key]) => (
          <div key={label}>
            <dt className="flex items-center gap-2 text-sm text-ink-2">
              {key && <span aria-hidden className={cn("inline-block size-3", SIDE_BAR[key])} />}
              {label}
            </dt>
            <dd className="rail-title text-[40px] tabular">{n}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 grid max-w-[46rem] grid-cols-[104px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-sm text-ink-2">
        <span>Everyone</span>
        <SplitBar sides={all} label="Everyone" />
        {d.inDistrict > 0 && (
          <>
            <span>In district</span>
            <span className="block" style={{ width: `${Math.max(4, Math.round((d.inDistrict / d.people) * 100))}%` }}>
              <SplitBar sides={district} label="In district" />
            </span>
          </>
        )}
      </div>
      {d.billId && (
        <Link href={`/bills/${d.billId}`}
          className="mt-5 inline-block text-base text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
          Open this bill
        </Link>
      )}

      {d.weeks.length > 1 && (
        <Block title="By week"><WeekBars weeks={d.weeks} /></Block>
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

      {answers && answers.groups.length > 0 && (
        <Block title="Answer them">
          <ul>
            {answers.groups.map((g) => (
              <li key={g.side} className="grid items-center gap-x-10 gap-y-2 border-b border-line py-4 md:grid-cols-[190px_minmax(0,1fr)_auto]">
                <p className="text-lg font-semibold text-ink">{SIDE_WORD[g.side]}</p>
                <p className="tabular text-base text-ink">
                  {g.toAnswer} to answer, {g.answered} answered{g.noAddress ? `, ${g.noAddress} with no address` : ""}
                </p>
                {g.draft ? (
                  <ActionLink href={`${ROOT}/replies`}>{g.draft.status === "approved" ? "Approved reply waiting" : "Reply in progress"}</ActionLink>
                ) : g.toAnswer > 0 ? (
                  <AnswerSideButton reference={d.reference} side={g.side} people={g.toAnswer} />
                ) : null}
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Who wrote">
        <Tabs name="bill-side" className="border-b border-line" current={side ?? "all"} items={[
          { key: "all", label: "All", href: href({ side: null }), count: d.people },
          ...(Object.keys(SIDE_WORD) as BillSide[]).map((k) => ({ key: k, label: SIDE_WORD[k], href: href({ side: k }), count: all[k] })),
        ]} />
        <ul>
          {d.letters.map((l) => (
            <li key={l.messageId} className="grid gap-x-10 gap-y-2 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_230px]">
              <div className="min-w-0">
                <Link href={mailHref(l.messageId)} className="text-lg font-semibold text-ink transition-colors hover:text-ink-2">{l.name}</Link>
                {l.quote && <p className="mt-1.5 text-md text-ink"><Marked>{l.quote}</Marked></p>}
              </div>
              <div className="text-sm text-ink-2">
                <StanceWord stance={l.position} className="text-sm" />
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
            {page > 1 && <ActionLink href={href({ page: page - 1 })}>Previous</ActionLink>}
            {d.hasMore && <ActionLink href={href({ page: page + 1 })}>Next</ActionLink>}
          </div>
        )}
      </Block>
    </div>
  );
}
