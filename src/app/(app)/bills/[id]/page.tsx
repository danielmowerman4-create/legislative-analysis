import type { Metadata } from "next";
import Link from "next/link";
import { ViewTransition } from "react";
import { ChevronRight, ExternalLink, Mail, Printer } from "lucide-react";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { getBillDetail, relatedBills, type RelatedBill } from "@/server/services/legislation";
import { billMailSummary } from "@/server/services/center";
import { billStages, sponsorSpectrum } from "@/server/legislation/stages";
import { citationLabel, isSection, reasonText } from "@/server/legislation/related";
import { ActionLink, Breadcrumbs, cn, Landmark, Table, Td, Th } from "@/components/ui";
import { Tabs } from "@/components/ui/blocks";
import { BillKicker, BillNumber, BillResult, BillTitle, CHAMBER, PartyMark, PositionMark, PriorityMark, BillRoad, stageWords } from "@/components/bills";
import { dateOnly, dayKey, eventTime, fullDate, relative, shortDate } from "@/lib/format";
import { FollowButton, LinkBillForm, NoteForm, OfficePanel, PositionButtons, UnlinkButton } from "../controls";
import { isPassageVote, isVoiceVote } from "@/server/legislation/scoring";
import { voteMark } from "@/lib/chamber";
import { VoteChamber } from "@/components/chamber";
import { PositionStamp } from "@/components/stamp";
import { listTeam } from "@/server/services/offices";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { ctx } = await requireOffice();
  const { id } = await params;
  try {
    const d = await getBillDetail(ctx, id);
    return { title: `${d.bill.identifier} ${d.bill.title}` };
  } catch {
    return { title: "Not found" };
  }
}

const TABS = ["overview", "timeline", "text", "votes", "related", "notes"] as const;
type Tab = (typeof TABS)[number];
const TITLE_SIZES: [number, string][] = [[240, "text-[26px] lg:text-[30px]"], [150, "text-[30px] lg:text-[38px]"], [90, "text-[36px] lg:text-[48px]"]];
const titleSize = (length: number) => TITLE_SIZES.find(([min]) => length > min)?.[1] ?? "text-[42px] lg:text-[62px]";
const BILL_TYPE: Record<string, string> = { HB: "House Bill", SB: "Senate Bill", HR: "House Resolution", SR: "Senate Resolution", HJR: "House Joint Resolution",
  SJR: "Senate Joint Resolution", HJ: "House Joint Resolution", SJ: "Senate Joint Resolution" };
const RELATED_GROUPS = [["connected", "Companions, other sessions and linked bills"], ["code", "Change the same code"],
  ["more", "Same sponsor or subject"]] as const;

const isCompanion = (x: RelatedBill["reasons"][number]) => x.kind === "companion" ||
  (x.kind === "source" && (x.relation === "same_as" || x.relation === "similar_to" || x.relation === "cross_filed"));

const dated = (when: string, what: React.ReactNode) => <><span className="tabular text-ink-2">{when}.</span> {what}</>;

type BillPageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> };

export default async function BillPage({ params, searchParams }: BillPageProps) {
  const session = await requireOffice();
  const { ctx } = session;
  const { id } = await params;
  const requested = (await searchParams).tab ?? "";
  const tab: Tab = (TABS as readonly string[]).includes(requested) ? (requested as Tab) : "overview";
  const [d, related, team, mail] = await orNotFound(Promise.all([getBillDetail(ctx, id), relatedBills(ctx, id), listTeam(ctx), billMailSummary(ctx, id)]));
  const b = d.bill;
  const { stages, outcome } = billStages(b, d.actions, { jointCommittees: b.jurisdictionCode === "CT" });
  const statusPage = b.provider === "ctga" ? b.sourceUrls[0] : null;
  const stage = stageWords(b.status, b.billType);
  const now = new Date();
  const adjourned = Boolean(d.session.endDate && d.session.endDate < dayKey(now));
  const upcoming = d.events.filter((e) => e.startsAt >= now && e.status === "scheduled");
  const past = d.events.filter((e) => !(e.startsAt >= now && e.status === "scheduled")).reverse();
  const last = d.actions[0];
  const companions = related.filter((r) => r.id && r.reasons.some(isCompanion));
  const officeVotes = [...d.votes].sort((a, b) => Number(isPassageVote(b.motion)) - Number(isPassageVote(a.motion)))
    .flatMap((v) => v.members.filter((m) => m.legislatorId === d.officeMemberId).map((m) => ({ id: v.id, motion: v.motion, date: v.voteDate, vote: m.vote })));
  const sponsorEmails = [...new Set(d.sponsors.flatMap((s) => s.contact?.email ?? []))];
  const spectrum = sponsorSpectrum(d.sponsors.map((s) => s.party));
  const canTrack = can(ctx, "legislation.track");
  const floor = d.votes.filter((v) => !/committee/i.test(v.motion));
  const committee = d.votes.filter((v) => /committee/i.test(v.motion));
  const tabHref = (t: Tab) => (t === "overview" ? `/bills/${id}` : `/bills/${id}?tab=${t}`);
  const codes = [...b.codeSections.filter(isSection),
    ...b.codeSections.filter((c) => !isSection(c) && !b.codeSections.some((s) => isSection(s) && s.startsWith(`${c}-`)))];
  const t = d.tracking;
  const tracking = t ? { position: t.position, priority: t.priority, reason: t.reason, assignedTo: t.assignedTo, nextStep: t.nextStep, dueDate: t.dueDate }
    : null;

  return (
    <>
      <header className="overflow-x-clip">
        <div className="wrap relative z-10 pt-5 text-center lg:pt-6">
          <div className="text-left lg:absolute lg:top-6">
            <Breadcrumbs items={[{ label: "Bills", href: "/bills" }, { label: BILL_TYPE[b.billType] ?? b.billType }]} />
          </div>
          <p className="anchor mt-2 text-[60px] text-ink uppercase lg:mt-0 lg:text-[76px]">{b.identifier}</p>
          <ViewTransition name={`bill-title-${id}`} share="morph" default="none">
            <h1 className={cn("anchor mx-auto mt-1 max-w-[1120px] text-ink uppercase [text-wrap:balance]", titleSize(b.title.length))}>{b.title}</h1>
          </ViewTransition>
          <p className="mt-2 text-md text-ink-2">{d.session.name}. <span className={cn("font-semibold", stage.tone)}>{stage.label}.</span></p>
          <div className="mx-auto mt-5 max-w-[1080px]"><BillRoad stages={stages} outcome={outcome} /></div>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-10 gap-y-2">
            {canTrack ? (
              <div className="flex flex-wrap items-center justify-center gap-x-5">
                <p className="kicker text-ink-2">Your office&apos;s position</p>
                <PositionButtons large billId={id} identifier={b.identifier} position={d.tracking?.position ?? null} />
              </div>
            ) : (
              d.tracking && <PositionStamp large position={d.tracking.position} seed={id} />
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2">
              <FollowButton billId={id} followed={d.followed} />
              <ActionLink href={d.versions.length >= 2 ? `/bills/${id}/compare` : `/compare?a=${id}`}>Compare text</ActionLink>
              <ActionLink href={`/bills/${id}/brief`} icon={Printer}>Bill brief</ActionLink>
            </div>
          </div>
        </div>
        <Landmark />
        <div className="wrap">
          <Tabs name="bill" className="mt-3" current={tab} items={[
            { key: "overview", label: "Overview", href: tabHref("overview") },
            { key: "timeline", label: "Timeline", href: tabHref("timeline"), count: d.actions.length },
            { key: "text", label: "Text", href: tabHref("text"), count: d.versions.length },
            { key: "votes", label: "Votes", href: tabHref("votes"), count: d.votes.length },
            { key: "related", label: "Related bills", href: tabHref("related"), count: related.length },
            { key: "notes", label: "Notes", href: tabHref("notes"), count: d.notes.length },
            { key: "whip", label: "Whip count", href: `/bills/${id}/whip` },
          ]} />
        </div>
      </header>

      <div>
        <dl className="wrap grid gap-x-14 gap-y-5 pt-2 pb-2 sm:grid-cols-2 lg:grid-cols-[1.4fr_1.4fr_1fr]">
          <Fact label="Last action">{last ? dated(dateOnly(last.actionDate), last.description) : "None recorded"}</Fact>
          {adjourned ? (
            <Fact label="Result"><BillResult status={b.status} statusText={b.statusText} /></Fact>
          ) : (
            <Fact label="Next on the calendar">{upcoming[0] ? dated(eventTime(upcoming[0].startsAt), upcoming[0].title) : "Nothing scheduled"}</Fact>
          )}
          <Fact label="Sponsors">{spectrum ?? (d.sponsors.length ? `${d.sponsors.length} sponsors` : "None recorded")}</Fact>
        </dl>
      </div>

      <div className="wrap grid gap-x-16 gap-y-12 py-10 lg:grid-cols-[minmax(0,1fr)_296px] lg:py-14">
        <ViewTransition key={tab} enter="tab-in" exit="tab-out" default="none">
        <div className="flex min-w-0 flex-col gap-10">
          {tab === "overview" && (
            <>
              {b.officialSummary && (
                <Block title="Statement of purpose"><p className="max-w-[68ch] text-base text-ink-2">{b.officialSummary}</p></Block>
              )}
              <Block title="Hearings and floor">
                {upcoming.length === 0 && past.length === 0 ? (
                  <p className="text-sm text-ink-3">No hearings or floor sessions on record.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {[...upcoming, ...past.slice(0, 3)].map((e) => (
                      <li key={e.id} className="grid gap-x-8 gap-y-0.5 py-4 sm:grid-cols-[200px_minmax(0,1fr)]">
                        <span className={cn("tabular text-sm", e.startsAt >= now ? "font-semibold text-ink" : "text-ink-3")}>{eventTime(e.startsAt)}</span>
                        <span className="min-w-0">
                          <span className="block text-sm text-ink">{e.title}</span>
                          <span className="block text-sm text-ink-3">{e.status === "cancelled" ? "Cancelled" : e.location}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Block>
              <Block title="Recent actions" href={tabHref("timeline")} linkLabel={`All ${d.actions.length} actions`}>
                <ActionList actions={d.actions.slice(0, 5)} />
              </Block>
              <Block title="Related bills" href={tabHref("related")} linkLabel={related.length ? `All ${related.length}` : undefined}>
                {related.length ? (
                  <RelatedTable rows={related.slice(0, 4)} billId={id} canTrack={canTrack} compact />
                ) : (
                  <p className="text-sm text-ink-3">No related bills found.</p>
                )}
              </Block>
            </>
          )}

          {tab === "timeline" && (
            <Block title="Every action">
              {d.actions.length ? <ActionList actions={d.actions} /> : <p className="text-sm text-ink-3">No actions recorded.</p>}
            </Block>
          )}

          {tab === "text" && (
            <Block title="Versions" href={`/compare?a=${id}`} linkLabel="Compare with a different bill">
              {d.versions.length === 0 ? (
                <p className="text-sm text-ink-3">The legislature has not published text for this bill.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {[...d.versions].reverse().map((v, i, all) => (
                    <li key={v.id} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 py-4">
                      <span className="min-w-48 flex-1 font-display text-md font-medium text-ink">{v.label}</span>
                      <span className="tabular w-32 text-sm text-ink-3">{dateOnly(v.versionDate)}</span>
                      <span className="flex gap-4 text-sm">
                        {i < all.length - 1 && (
                          <Link href={`/bills/${id}/compare?from=${all[i + 1].id}&to=${v.id}`}
                            className="font-semibold text-ink underline decoration-rule underline-offset-4 hover:text-ink-2">
                            Changes from {all[i + 1].label}
                          </Link>
                        )}
                        {v.url && (
                          <a href={v.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
                            Source <ExternalLink className="size-3.5" strokeWidth={1.75} />
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Block>
          )}

          {tab === "votes" && (
            <>
              {d.votes.length === 0 && (
                <Block title="Votes"><p className="text-sm text-ink-3">No roll call votes on record.</p></Block>
              )}
              {floor.length > 0 && <Block title="Floor votes"><VoteList votes={floor} officeId={d.officeMemberId} /></Block>}
              {committee.length > 0 && <Block title="Committee votes"><VoteList votes={committee} /></Block>}
            </>
          )}

          {tab === "related" && (
            <>
              {canTrack && (
                <div className="flex"><LinkBillForm billId={id} /></div>
              )}
              {related.length === 0 ? (
                <p className="text-sm text-ink-3">No related bills found.</p>
              ) : (
                RELATED_GROUPS.map(([group, title]) => (
                  <RelatedGroup key={group} title={title} rows={related.filter((r) => r.group === group)} billId={id} canTrack={canTrack} />
                ))
              )}
            </>
          )}

          {tab === "notes" && (
            <Block title="Office notes">
              {canTrack && <NoteForm billId={id} />}
              <ul className="mt-6 divide-y divide-line">
                {d.notes.map((n) => (
                  <li key={n.id} className="py-4">
                    <p className="text-sm">
                      <span className="font-semibold text-ink">{n.author ?? "Former staff member"}</span>{" "}
                      <span className="text-ink-3" title={fullDate(n.createdAt)}>{relative(n.createdAt)}</span>
                    </p>
                    <p className="hand mt-1.5 max-w-[60ch] whitespace-pre-wrap">{n.body}</p>
                  </li>
                ))}
                {d.notes.length === 0 && <li className="py-4 text-sm text-ink-3">No notes yet.</li>}
              </ul>
            </Block>
          )}
        </div>
        </ViewTransition>

        <aside className="flex min-w-0 flex-col gap-7" aria-label="Bill details">
          <Side title="Your office">
            {canTrack ? (
              <OfficePanel
                billId={id}
                tracking={tracking}
                team={team.filter((m) => m.status === "active").map((m) => ({ userId: m.userId, name: m.name }))}
                companions={companions.map((c) => ({ id: c.id!, identifier: c.identifier, tracked: Boolean(c.position) }))}
              />
            ) : d.tracking ? (
              <div className="flex flex-col gap-1.5">
                <span className="flex flex-wrap items-center gap-3">
                  <PositionMark position={d.tracking.position} className="text-md" />
                  <PriorityMark priority={d.tracking.priority} withLabel />
                </span>
                {d.tracking.reason && <p className="text-sm text-ink">{d.tracking.reason}</p>}
              </div>
            ) : (
              <p className="text-sm text-ink-3">Not tracked</p>
            )}
            {d.notes[0] && (
              <Link href={tabHref("notes")} className="mt-4 block border-t border-line pt-3 text-sm text-ink-2 transition-colors hover:text-ink">
                <span className="line-clamp-3">{d.notes[0].body}</span>
                <span className="mt-1.5 block text-ink-3">{d.notes[0].author ?? "Staff"}, {relative(d.notes[0].createdAt)}</span>
              </Link>
            )}
          </Side>
          {mail && (
            <Side title="Who wrote in">
              <p className="text-base text-ink">
                {mail.people} {mail.people === 1 ? "person" : "people"}: {mail.support} support, {mail.oppose} oppose, {mail.inDistrict} in district
              </p>
              <Link href={`/constituent-center/topics/${encodeURIComponent(mail.reference)}`}
                className="mt-1 inline-block text-sm text-ink-2 underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                See who wrote
              </Link>
            </Side>
          )}
          {officeVotes.length > 0 && (
            <Side title={`How ${session.org.legislatorName ?? "your member"} voted`}>
              <ul className="flex flex-col gap-2">
                {officeVotes.slice(0, 6).map((v) => (
                  <li key={v.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 text-ink">
                      {v.motion} <span className="tabular whitespace-nowrap text-ink-3">{v.date ? shortDate(v.date) : ""}</span>
                    </span>
                    <span className={cn("shrink-0 font-semibold", v.vote === "yes" ? "text-support" : v.vote === "no" ? "text-oppose" : "text-ink-3")}>
                      {v.vote === "yes" ? "Yes" : v.vote === "no" ? "No" : "Did not vote"}
                    </span>
                  </li>
                ))}
              </ul>
              {officeVotes.length > 6 && (
                <Link href={tabHref("votes")}
                  className="mt-3 inline-block text-sm text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
                  All {officeVotes.length} votes
                </Link>
              )}
            </Side>
          )}
          <Side title="Sponsors">
            <ul className="flex flex-col gap-2">
              {d.sponsors.slice(0, 12).map((s) => (
                <li key={s.id} className="flex items-baseline gap-2 text-sm">
                  {s.legislatorId ? (
                    <Link href={`/legislators/${s.legislatorId}`} className="min-w-0 truncate text-ink hover:underline">{s.name}</Link>
                  ) : (
                    <span className="min-w-0 truncate text-ink">{s.name}</span>
                  )}
                  <PartyMark party={s.party} district={s.district} />
                  {s.sponsorType === "primary" && <span className="ml-auto shrink-0 text-ink-3">Lead</span>}
                </li>
              ))}
              {d.sponsors.length > 12 && <li className="text-sm text-ink-3">and {d.sponsors.length - 12} more</li>}
              {d.sponsors.length === 0 && <li className="text-sm text-ink-3">None recorded</li>}
            </ul>
            {sponsorEmails.length > 0 && (
              <ActionLink plain href={`mailto:${sponsorEmails.join(",")}?subject=${encodeURIComponent(`${b.identifier}: ${b.title}`)}`} icon={Mail}
                className="mt-4">
                {sponsorEmails.length === 1 ? "Email sponsor" : `Email ${sponsorEmails.length} sponsors`}
              </ActionLink>
            )}
          </Side>
          <Side title="Committees">
            <ul className="flex flex-col gap-2">
              {d.committees.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <Link href={`/committees/${c.id}`} className="min-w-0 text-ink hover:underline">{c.name}</Link>
                  <span className="tabular shrink-0 text-ink-3">{c.referredAt ? shortDate(c.referredAt) : ""}</span>
                </li>
              ))}
              {d.committees.length === 0 && <li className="text-sm text-ink-3">Not referred</li>}
            </ul>
          </Side>
          <Side title="Code it changes">
            {codes.length ? (
              <ul className="flex flex-col gap-1.5">
                {codes.map((c) => (
                  <li key={c}>
                    <Link href={`/bills?code=${encodeURIComponent(c)}`} className="text-sm text-ink hover:underline"
                      title={`Other bills that change ${citationLabel(c)}`}>
                      {citationLabel(c)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No code citations found</p>
            )}
          </Side>
          {b.subjects.length > 0 && (
            <Side title="Subjects">
              <p className="text-sm leading-6">
                {b.subjects.map((s, i) => (
                  <span key={s}>
                    <Link href={`/bills?subject=${encodeURIComponent(s)}`} className="text-ink hover:underline">{s}</Link>
                    {i < b.subjects.length - 1 ? <span className="text-ink-3">, </span> : null}
                  </span>
                ))}
              </p>
            </Side>
          )}
          {b.sourceUrls.length > 0 && (
            <Side title="Source">
              <ul className="flex flex-col gap-1.5">
                {b.sourceUrls.map((u) => (
                  <li key={u.url}>
                    <a href={u.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-ink hover:underline">
                      {u.label} <ExternalLink className="size-3.5 text-ink-3" strokeWidth={1.75} />
                    </a>
                  </li>
                ))}
              </ul>
              {b.lastSyncedAt && !statusPage && <p className="mt-2 text-sm text-ink-3">Checked {relative(b.lastSyncedAt)}</p>}
            </Side>
          )}
        </aside>
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0"><dt className="kicker text-ink-3">{label}</dt><dd className="mt-1 text-base text-ink">{children}</dd></div>
  );
}

function Block({ title, href, linkLabel, children }: { title: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-1">
        <h2 className="rail-title text-[40px] text-ink">{title}</h2>
        {href && linkLabel && <ActionLink href={href}>{linkLabel}</ActionLink>}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Side({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0"><h2 className="display mb-2.5 text-[24px] text-ink">{title}</h2>{children}</section>
  );
}

function ActionList({ actions }: { actions: { id: string; actionDate: string; chamber: string | null; description: string }[] }) {
  return (
    <ol className="divide-y divide-line">
      {actions.map((a) => (
        <li key={a.id} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-0.5 py-4 text-sm sm:grid-cols-[96px_72px_minmax(0,1fr)]">
          <span className="tabular text-ink-3">{shortDate(a.actionDate)}</span>
          <span className="text-ink-3">{a.chamber ? (CHAMBER[a.chamber] ?? a.chamber) : ""}</span>
          <span className="col-span-2 text-ink sm:col-span-1">{a.description}</span>
        </li>
      ))}
    </ol>
  );
}

type Vote = Awaited<ReturnType<typeof getBillDetail>>["votes"][number];
const partyKey = (p: string | null) => (p ?? "?").slice(0, 1).toUpperCase();

function VoteList({ votes, officeId }: { votes: Vote[]; officeId?: string | null }) {
  return (
    <ul className="divide-y divide-line">
      {votes.map((v) => {
        const parties = [...new Set(v.members.map((m) => partyKey(m.party)))].sort().reverse();
        const count = (p: string, pred: (vote: string) => boolean) => v.members.filter((m) => partyKey(m.party) === p && pred(m.vote)).length;
        const total = v.yes + v.no;
        return (
          <li key={v.id} className="py-6">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-display text-md font-medium text-ink">{v.motion}</span>
              <span className="tabular text-sm text-ink-3">
                {v.voteDate ? dateOnly(v.voteDate) : "Date not recorded"}
                {v.chamber ? ` · ${CHAMBER[v.chamber] ?? v.chamber}` : ""}
              </span>
              <span className={cn("ml-auto text-sm font-semibold", v.passed ? "text-ok" : v.passed === false ? "text-danger" : "text-ink-2")}>
                {v.passed ? "Passed" : v.passed === false ? "Failed" : "Result not recorded"}
              </span>
            </div>
            {isVoiceVote(v) ? (
              <p className="mt-3 text-sm text-ink-2">Voice vote. Members were not individually recorded.</p>
            ) : (
            <div className="mt-3 flex items-center gap-4">
              <span className="tabular text-sm text-ink">
                <span className="font-semibold">{v.yes}</span> <span className="text-ink-3">yes</span>
                <span className="mx-2 text-ink-3">·</span>
                <span className="font-semibold">{v.no}</span> <span className="text-ink-3">no</span>
                {v.other ? (
                  <>
                    <span className="mx-2 text-ink-3">·</span>
                    <span className="font-semibold">{v.other}</span> <span className="text-ink-3">not voting</span>
                  </>
                ) : null}
              </span>
              {total > 0 && !(v.chamber && v.members.length > 0 && isPassageVote(v.motion)) && (
                <span aria-hidden className="flex h-1 max-w-64 flex-1 bg-surface-3">
                  <span className="bg-ok" style={{ width: `${(v.yes / (total + v.other)) * 100}%` }} />
                  <span className="bg-danger/70" style={{ width: `${(v.no / (total + v.other)) * 100}%` }} />
                </span>
              )}
            </div>
            )}
            {v.members.length > 0 && (
              <>
                <div className={cn("mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5", v.chamber && "xl:grid-cols-[minmax(0,1fr)_296px] xl:items-start")}>
                  {v.chamber && (
                    <VoteChamber
                      id={v.id}
                      open={isPassageVote(v.motion)}
                      officeId={officeId}
                      value={v.yes}
                      seats={v.members.map((m) => ({ id: m.legislatorId ?? m.name, name: m.name, party: m.party, district: m.district,
                        mark: voteMark(m.vote) }))}
                    />
                  )}
                  <Table>
                  <thead>
                    <tr>
                      <Th>Party</Th>
                      <Th align="right">Yes</Th>
                      <Th align="right">No</Th>
                      <Th align="right">Not voting</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {parties.map((p) => (
                      <tr key={p}>
                        <Td className="py-2">
                          <span className={cn("font-semibold", p === "R" ? "text-party-r" : p === "D" ? "text-party-d" : "text-ink-2")}>
                            {p === "R" ? "Republican" : p === "D" ? "Democrat" : "Other"}
                          </span>
                        </Td>
                        <Td align="right" className="py-2">{count(p, (x) => x === "yes")}</Td>
                        <Td align="right" className="py-2">{count(p, (x) => x === "no")}</Td>
                        <Td align="right" className="py-2">{count(p, (x) => x !== "yes" && x !== "no")}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                </div>
                <details className="group mt-3 text-sm">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-ink-2 hover:text-ink">
                    <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" strokeWidth={1.75} />
                    How each member voted
                  </summary>
                  <div className="mt-3 grid gap-6 sm:grid-cols-3">
                    {(["yes", "no", "not_voting"] as const).map((k) => {
                      const list = v.members.filter((m) => (k === "not_voting" ? m.vote !== "yes" && m.vote !== "no" : m.vote === k));
                      return (
                        <div key={k}>
                          <p className="mb-2 font-semibold text-ink">
                            {k === "yes" ? "Yes" : k === "no" ? "No" : "Not voting"} <span className="tabular font-normal text-ink-3">{list.length}</span>
                          </p>
                          <ul className="flex flex-col gap-1">
                            {list.map((m) => (
                              <li key={m.name} className="flex items-baseline gap-1.5">
                                {m.legislatorId ? (
                                  <Link href={`/legislators/${m.legislatorId}`} className="truncate text-ink hover:underline">{m.name}</Link>
                                ) : (
                                  <span className="truncate text-ink">{m.name}</span>
                                )}
                                <PartyMark party={m.party} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RelatedGroup({ title, rows, billId, canTrack }: { title: string; rows: RelatedBill[]; billId: string; canTrack: boolean }) {
  if (!rows.length) return null;
  return (
    <Block title={`${title} · ${rows.length}`}><RelatedTable rows={rows} billId={billId} canTrack={canTrack} /></Block>
  );
}

function RelatedTable({ rows, billId, canTrack, compact }: { rows: RelatedBill[]; billId: string; canTrack: boolean; compact?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id ?? r.identifier} className={cn("grid gap-x-8 gap-y-2 py-5",
          compact ? "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]" : "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_120px]")}>
          {r.id ? (
            <Link href={`/bills/${r.id}`} className="group min-w-0">
              <BillKicker identifier={r.identifier} status={compact ? undefined : r.status} />
              <BillTitle className="mt-1 block">{r.title}</BillTitle>
              <span className="mt-1 block text-sm text-ink-2">{[r.session, r.primarySponsor].filter(Boolean).join(" · ")}</span>
            </Link>
          ) : (
            <span className="min-w-0">
              <BillNumber identifier={r.identifier} />
              <span className="mt-1 block text-sm text-ink-3">Not loaded from the source yet</span>
            </span>
          )}
          <ul className="flex min-w-0 flex-col gap-0.5 text-sm text-ink-2 md:pt-6">
            {r.reasons.map((x, i) => (
              <li key={i}>{reasonText(x, r.chamber ? CHAMBER[r.chamber] : undefined)}</li>
            ))}
          </ul>
          <span className="flex flex-col items-start gap-1 md:items-end md:pt-6">
            {!compact && r.position && <PositionMark position={r.position} />}
            <span className="flex items-center gap-2">
              {r.id && (
                <Link href={`/compare?a=${billId}&b=${r.id}`}
                  className="text-sm font-semibold whitespace-nowrap text-ink underline decoration-rule underline-offset-4 hover:text-ink-2">
                  Compare
                </Link>
              )}
              {canTrack && r.id && r.reasons.some((x) => x.kind === "office") && <UnlinkButton billId={billId} otherId={r.id} identifier={r.identifier} />}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
