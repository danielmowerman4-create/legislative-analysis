import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { centerCounts, needsAPerson, type DistrictView } from "@/server/services/center";
import { AskRows, Block, DISTRICT_VIEWS, mailHref, Marked, NoteRows, PageTitle, ROOT, SenderRows, WaitingSince } from "@/components/center/parts";
import { Street, Tally } from "@/components/center/art";
import { Status } from "@/components/ui";
import { Segmented } from "@/components/ui/blocks";
import { shortDate } from "@/lib/format";

export default async function NeedsAPersonPage({ searchParams }: { searchParams: Promise<{ district?: string }> }) {
  const { ctx } = await requireCenter();
  const sp = await searchParams;
  const district = sp.district && Object.hasOwn(DISTRICT_VIEWS, sp.district) ? (sp.district as DistrictView) : undefined;
  const d = await needsAPerson(ctx, { district });
  // Same count as the rail, so the two always agree.
  const { needsPerson } = await centerCounts(ctx);
  const canTriage = can(ctx, "inbox.triage");
  const lead = d.urgent[0];
  const rest = d.urgent.slice(1);
  const nothing = !d.urgent.length && !d.senders.length && !d.casework.length && !d.others.length && !d.personal.length;
  const sections = [
    { id: "urgent", title: "Urgent", shown: rest.length > 0 },
    { id: "who-sent-this", title: "Who sent this?", shown: d.senders.length > 0 },
    { id: "asking-for-help", title: "Asking for help", shown: d.casework.length > 0 },
    { id: "wrote-more", title: "Wrote more than the form letter", shown: d.personal.length > 0 },
    { id: "other-requests", title: "Other requests", shown: d.others.length > 0 },
  ].filter((s) => s.shown);
  const has = (id: string) => sections.some((s) => s.id === id);

  return (
    <>
      <PageTitle title="Needs a person">
        {needsPerson > 0 && (
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Tally count={needsPerson} />
            <span className="hand text-lg">{needsPerson} waiting</span>
          </p>
        )}
        {(d.anyonePlaced || district) && (
          <div className="relative z-10 mt-4">
            <Segmented label="District" showLabel={false} current={district ?? "all"} items={[{ key: "all", label: "All", href: ROOT },
              ...Object.entries(DISTRICT_VIEWS).map(([key, label]) => ({ key, label, href: `${ROOT}?district=${key}` }))]} />
          </div>
        )}
      </PageTitle>

      {lead && (
        <Link href={mailHref(lead.messageId)} className="group relative z-10 mt-10 block max-w-[46rem]">
          <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-base text-ink-2">
            <span className="font-semibold text-ink">{lead.fromName ?? lead.fromAddress}</span>
            <Status tone={lead.urgency === "urgent" ? "danger" : "warn"}>
              {lead.dueAt ? `Due ${shortDate(lead.dueAt)}` : lead.urgency === "urgent" ? "Urgent" : "Soon"}
            </Status>
            <WaitingSince at={lead.receivedAt} />
          </p>
          <p className="mt-3 line-clamp-5 text-[32px] leading-[1.34] font-semibold text-balance text-ink lg:text-[36px] xl:text-[42px] min-[90rem]:text-[48px]">
            <Marked>{lead.quote}</Marked>
          </p>
          <p className="kicker mt-4 flex items-center gap-2 text-ink">
            Open this message
            <ArrowRight aria-hidden className="size-4 text-rule transition-transform duration-200 ease-(--expo) group-hover:translate-x-1" strokeWidth={2} />
          </p>
        </Link>
      )}

      {nothing && <p className="relative z-10 mt-9 text-[32px] leading-[1.34] text-ink lg:text-[42px]">Nobody is waiting.</p>}

      <Street />

      {sections.length > 1 && (
        <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-x-8 gap-y-1 border-b border-line pb-3">
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-sm text-ink-2 transition-colors duration-150 hover:text-ink">{s.title}</a>
          ))}
        </nav>
      )}

      {has("urgent") && (
        <Block id="urgent" title="Urgent"><AskRows items={rest} canTriage={canTriage} /></Block>
      )}
      {has("who-sent-this") && <Block id="who-sent-this" title="Who sent this?"><SenderRows items={d.senders} canManage={can(ctx, "senders.manage")} /></Block>}
      {has("asking-for-help") && <Block id="asking-for-help" title="Asking for help"><AskRows items={d.casework} canTriage={canTriage} /></Block>}
      {has("wrote-more") && <Block id="wrote-more" title="Wrote more than the form letter"><NoteRows items={d.personal} /></Block>}
      {has("other-requests") && <Block id="other-requests" title="Other requests"><AskRows items={d.others} canTriage={canTriage} /></Block>}
    </>
  );
}
