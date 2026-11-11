import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { centerCounts, centerEnabled } from "@/server/services/center";
import { legislativeFreshness, listEvents, POSITION_LABEL, todayBriefing } from "@/server/services/legislation";
import type { BillPosition } from "@/server/db/schema";
import { ActionLink, cn, Landmark, PageHeader, SepList } from "@/components/ui";
import { BillSearch } from "@/components/bill-search";
import { CenterDoor } from "@/components/center/door";
import { Freshness, Section } from "@/components/ui/blocks";
import { BillLine, CHAMBER, Meeting, MeetingBill, PositionMark, PriorityMark } from "@/components/bills";
import { dayKey, dayLabel, dateOnly, DISPLAY_TIME_ZONE, isDateOnly, shortDate, timeOnly } from "@/lib/format";
import { isVoiceVote } from "@/server/legislation/scoring";

export const metadata: Metadata = { title: "Today" };

const longDate = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: DISPLAY_TIME_ZONE });

export default async function TodayPage() {
  const { ctx } = await requireOffice();
  const now = new Date();
  const today = dayKey(now);
  const range = { from: new Date(now.getTime() - 3600_000), to: new Date(now.getTime() + 14 * 86400_000), trackedOnly: true };
  const [brief, events, fresh] = await Promise.all([todayBriefing(ctx), listEvents(ctx, range), legislativeFreshness(ctx)]);
  const byDay = new Map<string, typeof events>();
  for (const e of events) byDay.set(dayKey(e.startsAt), [...(byDay.get(dayKey(e.startsAt)) ?? []), e]);
  const trackedTotal = Object.values(brief.positions).reduce((s, n) => s + (n ?? 0), 0);
  const counts = (Object.keys(POSITION_LABEL) as BillPosition[]).filter((p) => brief.positions[p]);
  const closed = brief.session?.closed ? brief.session : null;
  const center = can(ctx, "inbox.read") && (await centerEnabled(ctx.orgId)) ? await centerCounts(ctx) : null;

  return (
    <>
      {center && <CenterDoor needsPerson={center.needsPerson} newMail={center.newMail} />}
      <PageHeader title="Today" meta={longDate.format(now)}>
        <div className="mx-auto max-w-[760px] text-center text-base text-ink-2">
          {trackedTotal > 0 && (
            <SepList center className="text-xl">
              <Link href="/tracked" className="font-semibold text-ink transition-colors hover:text-ink-2">{trackedTotal} tracked</Link>
              {counts.map((p) => (
                <Link key={p} href={`/tracked?position=${p}`} className="transition-colors hover:text-ink">
                  {brief.positions[p]} {POSITION_LABEL[p].toLowerCase()}
                </Link>
              ))}
            </SepList>
          )}
          <SepList center className="mt-2">
            {closed ? (
              <span>
                {closed.name} adjourned {dateOnly(closed.endDate)}
              </span>
            ) : (
              trackedTotal > 0 && (
                <Link href="/calendar?scope=tracked" className="transition-colors hover:text-ink">
                  {events.length} {events.length === 1 ? "hearing" : "hearings"} in the next 14 days
                </Link>
              )
            )}
            <Freshness at={fresh.lastOk?.finishedAt} stale={fresh.stale} label="Checked with the state" snapshotAt={fresh.snapshotAt} />
          </SepList>
          <div className="mt-4 flex flex-wrap justify-center gap-x-7 gap-y-2">
            <ActionLink href="/compare">Compare two bills</ActionLink>
            <ActionLink href="/reports">Print a report</ActionLink>
            <ActionLink href="/alerts">Set an alert</ActionLink>
          </div>
          <BillSearch className="mx-auto mt-4 max-w-[620px]" />
        </div>
      </PageHeader>
      <Landmark className="landmark-clear" />

      {brief.followUps.length > 0 && (
        <div className="wrap">
          <Section title="Follow-ups" href="/tracked?mine=1" linkLabel="Assigned to me">
            <ul className="flex flex-col">
              {brief.followUps.map((f) => (
                <BillLine
                  key={f.id}
                  href={`/bills/${f.id}`}
                  identifier={f.identifier}
                  title={f.title}
                  note={
                    <span className="hand">
                      {[f.nextStep, f.assignee ? `Handled by ${f.assignedTo === ctx.userId ? "you" : f.assignee}` : null].filter(Boolean).join(". ")}
                    </span>
                  }
                  right={
                    f.dueDate ? (
                      <span className={cn("tabular text-sm font-semibold whitespace-nowrap", f.dueDate < today ? "text-danger" : "text-ink")}>
                        {f.dueDate < today ? "Overdue, " : "Due "}
                        {shortDate(f.dueDate)}
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </ul>
          </Section>
        </div>
      )}

      {closed ? (
        <>
          {brief.seats.length > 0 && <YourCommittees seats={brief.seats} />}
          <ClosedSession results={brief.results} />
        </>
      ) : (
      <div className="wrap">
        <Section title="Coming up on tracked bills" href="/calendar" linkLabel="Calendar">
          {events.length === 0 ? (
            <Empty>No hearings or floor sessions on tracked bills in the next two weeks.</Empty>
          ) : (
            <ol className="flex flex-col gap-9">
              {[...byDay.entries()].map(([day, list]) => {
                const label = dayLabel(list[0].startsAt, now);
                return (
                  <li key={day}>
                    <h3 className={cn("kicker border-b-2 border-ink pb-2.5", label === "Today" ? "text-accent" : "text-ink")}>{label}</h3>
                    <ul className="divide-y divide-line">
                      {list.map((e) => (
                        <Meeting key={e.id} time={isDateOnly(e.startsAt) ? null : timeOnly(e.startsAt)} title={e.title} detail={e.location}
                          prepHref={e.bills.length ? `/calendar/${e.id}/prep` : undefined}>
                          <ul className="mt-3">
                            {e.bills
                              .filter((b) => b.position)
                              .map((b) => (
                                <MeetingBill key={b.id} id={b.id} identifier={b.identifier} title={b.title} position={b.position} priority={b.priority} />
                              ))}
                          </ul>
                        </Meeting>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
        </Section>

        <Section title="Moved in the last 7 days" href="/bills?view=tracked" linkLabel="Tracked bills">
          {brief.moved.length === 0 ? (
            <Empty>No actions on tracked bills this week.</Empty>
          ) : (
            <ol className="flex flex-col">
              {brief.moved.map((m, i) => (
                <BillLine
                  key={`${m.billId}-${i}`}
                  href={`/bills/${m.billId}`}
                  identifier={m.identifier}
                  title={m.title}
                  note={
                    <>
                      {m.description}
                      <span className="whitespace-nowrap text-ink-3">
                        {" "}
                        {shortDate(m.actionDate)}
                        {m.chamber ? `, ${CHAMBER[m.chamber] ?? m.chamber}` : ""}
                      </span>
                    </>
                  }
                  right={<PriorityMark priority={m.priority} />}
                />
              ))}
            </ol>
          )}
        </Section>

        <Section title="Bills this office leads" href="/bills?view=sponsored" linkLabel="All sponsored">
          {brief.own.length === 0 ? (
            <Empty>
              {brief.sponsorName ? "No bills with this office's legislator as lead sponsor."
                : "Add the legislator's name in Settings to list the office's bills here."}
            </Empty>
          ) : (
            <ul className="flex flex-col">
              {brief.own.map((b) => (
                <BillLine key={b.id} href={`/bills/${b.id}`} identifier={b.identifier} title={b.title} status={b.status} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent votes on tracked bills">
          {brief.votes.length === 0 ? (
            <Empty>No roll call votes on tracked bills in the last 30 days.</Empty>
          ) : (
            <ul className="flex flex-col">
              {brief.votes.map((v) => (
                <BillLine
                  key={v.id}
                  href={`/bills/${v.billId}?tab=votes`}
                  identifier={v.identifier}
                  title={v.motion}
                  note={
                    <span className="tabular">
                      {isVoiceVote(v) ? "Voice vote" : `${v.yes}–${v.no}`} on {v.voteDate ? dateOnly(v.voteDate) : "a date not recorded"}
                    </span>
                  }
                  right={
                    <span className={cn("text-sm font-semibold", v.passed ? "text-ok" : v.passed === false ? "text-danger" : "text-ink-2")}>
                      {v.passed ? "Passed" : v.passed === false ? "Failed" : "Result not recorded"}
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Section>
      </div>
      )}
    </>
  );
}

type Brief = Awaited<ReturnType<typeof todayBriefing>>;

function YourCommittees({ seats }: { seats: Brief["seats"] }) {
  return (
    <section aria-labelledby="your-committees">
      <div className="wrap pt-20 pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
          <h2 id="your-committees" className="rail-title text-[46px] text-ink lg:text-[60px]">Your committees</h2>
          <ActionLink href="/committees">All committees</ActionLink>
        </div>
        <ul className="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
          {seats.map((c) => (
            <li key={c.id}>
              <Link href={`/committees/${c.id}`} className="group block">
                <span className="kicker block text-ink-2">{c.role}</span>
                <span className="mt-1 block font-display text-[30px] leading-[1.05] font-bold text-ink decoration-rule decoration-2 underline-offset-4 group-hover:underline">
                  {c.name.replace(/ Committee$/, "")}
                </span>
                <span className="tabular mt-1 block text-sm text-ink-2">{c.bills} {c.bills === 1 ? "bill" : "bills"}, {c.enacted} became law</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ClosedSession({ results }: { results: Brief["results"] }) {
  const onePassed = (r: Brief["results"][number]) => r.status === "failed" && Boolean(r.statusText?.startsWith("Passed the"));
  const groups: [string, Brief["results"]][] = [
    ["Became law", results.filter((r) => r.status === "enacted")],
    ["Adopted or passed both chambers", results.filter((r) => r.status === "passed_both" || r.status === "passed_chamber" || r.status === "sent_to_executive")],
    ["Passed one chamber", results.filter(onePassed)],
    ["Did not pass", results.filter((r) => r.status === "failed" && !onePassed(r))],
  ];
  return (
    <div className="wrap">
      {results.length === 0 && (
        <Section title="Tracked bills" href="/bills" linkLabel="All bills"><Empty>No tracked bills yet.</Empty></Section>
      )}
      {groups.map(([title, rows]) =>
        rows.length === 0 ? null : (
          <Section key={title} title={title} meta={`${rows.length} ${rows.length === 1 ? "bill" : "bills"}`}>
            <ul className="flex flex-col">
              {rows.map((r) => (
                <BillLine key={r.id} href={`/bills/${r.id}`} identifier={r.identifier} title={r.title} note={ title === "Did not pass" ||
                  title === "Passed one chamber" ? r.statusText : [r.statusText, r.statusDate ? shortDate(r.statusDate) : null].filter(Boolean).join(", ") }
                  right={<PositionMark position={r.position} />} />
              ))}
            </ul>
          </Section>
        ),
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="border-y border-line py-5 text-sm text-ink-3">{children}</p>;
}
