import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarPlus } from "lucide-react";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { PositionButtons } from "../bills/controls";
import { latestEventDate, listEvents, sessionState } from "@/server/services/legislation";
import { localTimeToIso } from "@/server/legislation/normalize";
import { ActionLink, EmptyState, PageHeader } from "@/components/ui";
import { Section, Segmented } from "@/components/ui/blocks";
import { Meeting, MeetingBill } from "@/components/bills";
import { dateOnly, dayKey, dayLabel, DISPLAY_TIME_ZONE, isDateOnly, timeOnly } from "@/lib/format";

export const metadata: Metadata = { title: "Calendar" };

const DAYS = 14;
const midnight = (day: string) => new Date(localTimeToIso(day, "00:00", DISPLAY_TIME_ZONE)!);

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ scope?: string; start?: string }> }) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const trackedOnly = sp.scope === "tracked";
  const canTrack = can(ctx, "legislation.track");
  const session = await sessionState(ctx);
  const closed = session?.closed ?? false;
  const latest = closed ? await latestEventDate(ctx, { trackedOnly }) : null;
  const opening = latest ? dayKey(new Date(latest.getTime() - (DAYS - 1) * 86400_000)) : dayKey(new Date());
  const start = midnight(sp.start && /^\d{4}-\d{2}-\d{2}$/.test(sp.start) ? sp.start : opening);
  const end = new Date(start.getTime() + DAYS * 86400_000);
  const events = await listEvents(ctx, { from: start, to: end, trackedOnly });
  const byDay = new Map<string, typeof events>();
  for (const e of events) byDay.set(dayKey(e.startsAt), [...(byDay.get(dayKey(e.startsAt)) ?? []), e]);
  const shift = (days: number) => dayKey(new Date(start.getTime() + days * 86400_000 + 12 * 3600_000));
  const href = (patch: { scope?: string; start?: string }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ scope: sp.scope, start: sp.start, ...patch })) if (v) p.set(k, v);
    const s = p.toString();
    return `/calendar${s ? `?${s}` : ""}`;
  };
  const today = dayKey(new Date());

  return (
    <>
      <PageHeader title="Calendar" meta={`${dateOnly(start)} – ${dateOnly(new Date(end.getTime() - 86400_000))}`} actions={
        closed ? undefined : (
          <ActionLink plain href={`/api/export/calendar${trackedOnly ? "?scope=tracked" : ""}`} icon={CalendarPlus}>Add to my calendar</ActionLink>
        )
      }>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-3 pb-7">
          <div className="flex items-center gap-5 pb-1.5 text-sm text-ink">
            <Link href={href({ start: shift(-DAYS) })} title="Previous two weeks"
              className="inline-flex h-10 items-center gap-1.5 transition-colors hover:text-ink-2">
              <ArrowLeft aria-hidden className="size-5" strokeWidth={1.5} />
              Earlier
            </Link>
            <Link href={href({ start: undefined })} className="font-semibold transition-colors hover:text-ink-2">{closed ? "Last hearings" : "Today"}</Link>
            <Link href={href({ start: shift(DAYS) })} title="Next two weeks"
              className="inline-flex h-10 items-center gap-1.5 transition-colors hover:text-ink-2">
              Later
              <ArrowRight aria-hidden className="size-5" strokeWidth={1.5} />
            </Link>
          </div>
          <Segmented center label="Which events" showLabel={false} current={trackedOnly ? "tracked" : "all"} items={[
            { key: "all", label: "All hearings", href: href({ scope: undefined }) },
            { key: "tracked", label: "Tracked bills only", href: href({ scope: "tracked" }) },
          ]} />
        </div>
      </PageHeader>
      <div className="wrap">
        {events.length === 0 ? (
          <EmptyState title={ trackedOnly ? closed ? "No hearings on tracked bills in these two weeks."
            : "No hearings or floor sessions on tracked bills in these two weeks." : closed ? "No hearings in these two weeks."
            : "No hearings or floor sessions scheduled in these two weeks." } />
        ) : (
          [...byDay.entries()].map(([day, list]) => (
            <Section key={day} id={`d-${day}`} title={dayLabel(list[0].startsAt)} titleClass={day === today ? "text-accent" : undefined}
              meta={`${list.length} ${list.length === 1 ? "meeting" : "meetings"}`}>
              <ul className="-mt-6 divide-y divide-line">
                {list.map((e) => (
                  <Meeting
                    key={e.id}
                    time={isDateOnly(e.startsAt) ? null : timeOnly(e.startsAt)}
                    title={e.title}
                    cancelled={e.status === "cancelled"}
                    prepHref={e.bills.length ? `/calendar/${e.id}/prep` : undefined}
                    detail={
                      <>
                        {[e.kind === "floor" ? "Floor session" : null, e.location].filter(Boolean).join(" · ")}
                        {e.status === "cancelled" && <span className="font-semibold text-danger"> · Cancelled</span>}
                      </>
                    }
                  >
                    {e.bills.length > 0 && (
                      <ul className="mt-3">
                        {e.bills.map((b) => (
                          <MeetingBill key={b.id} id={b.id} identifier={b.identifier} title={b.title} status={b.status} position={b.position}
                            priority={b.priority}
                            actions={canTrack ? <PositionButtons noStamp billId={b.id} identifier={b.identifier} position={b.position} /> : undefined} />
                        ))}
                      </ul>
                    )}
                  </Meeting>
                ))}
              </ul>
            </Section>
          ))
        )}
      </div>
    </>
  );
}
