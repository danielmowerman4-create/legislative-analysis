import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarPlus } from "lucide-react";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { PositionButtons } from "../bills/controls";
import { CALENDAR_SCOPES, hasUpcomingOwn, officeCalendar, type CalendarScope } from "@/server/services/calendar";
import { latestEventDate, sessionState } from "@/server/services/legislation";
import { localTimeToIso } from "@/server/legislation/normalize";
import { ActionLink, EmptyState, PageHeader } from "@/components/ui";
import { Section, Segmented } from "@/components/ui/blocks";
import { Meeting, MeetingBill } from "@/components/bills";
import { dateOnly, dayKey, dayLabel, DISPLAY_TIME_ZONE, isDateOnly, timeOnly } from "@/lib/format";
import { AddEvent, OwnEventControls } from "./controls";

export const metadata: Metadata = { title: "Calendar" };

const DAYS = 14;
const midnight = (day: string) => new Date(localTimeToIso(day, "00:00", DISPLAY_TIME_ZONE)!);
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: DISPLAY_TIME_ZONE });

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ scope?: string; start?: string }> }) {
  const { ctx } = await requireOffice();
  const sp = await searchParams;
  const scope: CalendarScope = sp.scope && Object.hasOwn(CALENDAR_SCOPES, sp.scope) ? (sp.scope as CalendarScope) : "mine";
  const canTrack = can(ctx, "legislation.track");
  const session = await sessionState(ctx);
  const closed = session?.closed ?? false;
  // After the session, open on the last hearings unless the office has put something ahead.
  const latest = closed && !(await hasUpcomingOwn(ctx)) ? await latestEventDate(ctx, { trackedOnly: scope === "tracked" }) : null;
  const opening = latest ? dayKey(new Date(latest.getTime() - (DAYS - 1) * 86400_000)) : dayKey(new Date());
  const start = midnight(sp.start && /^\d{4}-\d{2}-\d{2}$/.test(sp.start) ? sp.start : opening);
  const end = new Date(start.getTime() + DAYS * 86400_000);
  const { hearings, own } = await officeCalendar(ctx, { from: start, to: end, scope });
  const entries = [...hearings.map((e) => ({ at: e.startsAt, hearing: e, own: null })), ...own.map((e) => ({ at: e.startsAt, hearing: null, own: e }))]
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const byDay = new Map<string, typeof entries>();
  for (const e of entries) byDay.set(dayKey(e.at), [...(byDay.get(dayKey(e.at)) ?? []), e]);
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
        <ActionLink plain href={`/api/export/calendar?scope=${scope}`} icon={CalendarPlus}>Add to my calendar</ActionLink>
      }>
        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-3 pb-5">
          <div className="flex items-center gap-5 pb-1.5 text-sm text-ink">
            <Link href={href({ start: shift(-DAYS) })} title="Previous two weeks"
              className="inline-flex h-10 items-center gap-1.5 transition-colors hover:text-ink-2">
              <ArrowLeft aria-hidden className="size-5" strokeWidth={1.5} />
              Earlier
            </Link>
            <Link href={href({ start: undefined })} className="font-semibold transition-colors hover:text-ink-2">{latest ? "Last hearings" : "Today"}</Link>
            <Link href={href({ start: shift(DAYS) })} title="Next two weeks"
              className="inline-flex h-10 items-center gap-1.5 transition-colors hover:text-ink-2">
              Later
              <ArrowRight aria-hidden className="size-5" strokeWidth={1.5} />
            </Link>
          </div>
          <Segmented center label="Which events" showLabel={false} current={scope} items={(Object.keys(CALENDAR_SCOPES) as CalendarScope[]).map((key) => (
            { key, label: CALENDAR_SCOPES[key], href: href({ scope: key === "mine" ? undefined : key }) }
          ))} />
        </div>
        {canTrack && <div className="flex justify-center pb-7"><AddEvent day={sp.start && sp.start >= today ? sp.start : today} scope={sp.scope} from={dayKey(start)} to={shift(DAYS - 1)} /></div>}
      </PageHeader>
      <div className="wrap">
        {entries.length === 0 ? (
          <EmptyState title={scope === "all" ? "Nothing scheduled in these two weeks."
            : scope === "tracked" ? "No hearings on tracked bills in these two weeks." : "Nothing for your committees or tracked bills in these two weeks."}
            action={scope === "all" ? undefined : <ActionLink href={href({ scope: "all" })}>All hearings</ActionLink>} />
        ) : (
          [...byDay.entries()].map(([day, list]) => (
            <Section key={day} id={`d-${day}`} title={dayLabel(list[0].at)} titleClass={day === today ? "text-accent" : undefined}
              meta={`${list.length} on the calendar`}>
              <ul className="-mt-6 divide-y divide-line">
                {list.map(({ hearing: e, own: o }) => e ? (
                  <Meeting key={e.id} time={isDateOnly(e.startsAt) ? null : timeOnly(e.startsAt)} title={e.title} cancelled={e.status === "cancelled"}
                    prepHref={e.bills.length ? `/calendar/${e.id}/prep` : undefined}
                    detail={
                      <>
                        {[e.kind === "floor" ? "Floor session" : null, e.location].filter(Boolean).join(" · ")}
                        {e.status === "cancelled" && <span className="font-semibold text-danger"> · Cancelled</span>}
                      </>
                    }>
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
                ) : o ? (
                  <Meeting key={o.id} time={o.allDay ? "All day" : timeOnly(o.startsAt)} title={o.title} detail={o.location}>
                    {o.note && <p className="hand mt-1.5 text-lg">{o.note}</p>}
                    {canTrack && (
                      <OwnEventControls id={o.id} event={{ title: o.title, date: dayKey(o.startsAt), time: o.allDay ? "" : clock.format(o.startsAt),
                        location: o.location ?? "", note: o.note ?? "" }} />
                    )}
                  </Meeting>
                ) : null)}
              </ul>
            </Section>
          ))
        )}
      </div>
    </>
  );
}
