import type { Metadata } from "next";
import Link from "next/link";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { getCommittee } from "@/server/services/legislation";
import { ActionLink, Breadcrumbs, cn, EmptyState, PageHeader, SepList } from "@/components/ui";
import { can } from "@/server/authz/context";
import { Mail } from "lucide-react";
import { PositionButtons } from "../../bills/controls";
import { Section } from "@/components/ui/blocks";
import { BillList, CHAMBER } from "@/components/bills";
import { eventTime, shortDate } from "@/lib/format";

export const metadata: Metadata = { title: "Committee" };

export default async function CommitteePage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const { committee, bills, events, members, closed } = await orNotFound(getCommittee(ctx, id));
  const now = new Date();
  const upcoming = closed ? events : events.filter((e) => e.startsAt >= now && e.status === "scheduled");
  const enacted = bills.filter((b) => b.status === "enacted");
  const onePassed = bills.filter((b) => b.status === "failed" && b.statusText?.startsWith("Passed the"));
  const dead = bills.filter((b) => b.status === "failed" && !b.statusText?.startsWith("Passed the"));
  const adopted = bills.filter((b) => b.status === "passed_both" || b.status === "passed_chamber" || b.status === "sent_to_executive");
  const pending = bills.filter((b) => b.status === "introduced" || b.status === "in_committee");
  const moved = bills.filter((b) => !(b.status === "introduced" || b.status === "in_committee"));
  const canTrack = can(ctx, "legislation.track");
  const memberEmails = [...new Set(members.flatMap((m) => m.contact?.email ?? []))];
  const chamber = committee.chamber && committee.chamber !== "joint" ? (CHAMBER[committee.chamber] ?? committee.chamber) : "Joint";

  return (
    <>
      <PageHeader
        title={committee.name}
        meta={`${chamber} committee`}
        actions={
          memberEmails.length ? (
            <ActionLink plain href={`mailto:${memberEmails.join(",")}?subject=${encodeURIComponent(committee.name)}`} icon={Mail}>Email members</ActionLink>
          ) : undefined
        }
        crumbs={<Breadcrumbs items={[{ label: "Committees", href: "/committees" }, { label: chamber }]} />}
      >
        <SepList center className="tabular pb-8 text-base text-ink-2">
          <span>
            {bills.length} {bills.length === 1 ? "bill" : "bills"} referred
          </span>
          {closed ? <span>{enacted.length} became law</span> : <span>{pending.length} still in committee</span>}
          <span>{bills.filter((b) => b.position).length} tracked by your office</span>
        </SepList>
      </PageHeader>
      <div className="wrap">
        {closed ? (
          <>
            <BillSection closed canTrack={canTrack} title="Became law" rows={enacted} />
            <BillSection closed canTrack={canTrack} title="Adopted or passed both chambers" rows={adopted} />
            <BillSection closed canTrack={canTrack} title="Passed one chamber" rows={onePassed} />
            <BillSection closed canTrack={canTrack} title="Did not pass" rows={dead} />
          </>
        ) : (
          <>
            <BillSection canTrack={canTrack} title="Waiting in committee" rows={pending} />
            <BillSection canTrack={canTrack} title="Reported or acted on" rows={moved} />
          </>
        )}
        {bills.length === 0 && <EmptyState title="No bills have been referred to this committee." />}
        {members.length > 0 && (
          <Section title="Members" meta={`${members.length} members`}>
            <ul className="grid gap-x-10 border-t border-line sm:grid-cols-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-x-4 border-b border-line py-3">
                  <Link href={`/legislators/${m.id}`} className="min-w-0 text-base font-semibold text-ink decoration-rule underline-offset-4 hover:underline">
                    {m.name}
                    <span className={cn("tabular ml-2 text-sm font-normal",
                      m.party === "R" ? "text-party-r" : m.party === "D" ? "text-party-d" : "text-ink-2")}>
                      {m.party}-{m.chamber === "upper" ? "S" : ""}{m.district}
                    </span>
                  </Link>
                  {m.role !== "Member" && <span className="text-sm whitespace-nowrap text-ink-2">{m.role}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title={closed ? "Public hearings" : "Upcoming meetings"}
          meta={closed && upcoming.length ? `${upcoming.length} ${upcoming.length === 1 ? "hearing" : "hearings"}` : undefined}>
          {upcoming.length === 0 ? (
            <p className="border-y border-line py-5 text-sm text-ink-3">{closed ? "No public hearings on record." : "None scheduled."}</p>
          ) : (
            <ul className="flex flex-col">
              {upcoming.map((e) => (
                <li key={e.id} className="py-5">
                  <p className="tabular text-sm font-semibold text-ink">{eventTime(e.startsAt)}</p>
                  <p className="mt-0.5 font-display text-md font-medium text-ink">{e.title}</p>
                  {e.location && <p className="text-sm text-ink-2">{e.location}</p>}
                  <p className="mt-1.5 flex flex-wrap gap-x-4">
                    {bills
                      .filter((b) => e.billIds.includes(b.id))
                      .map((b) => (
                        <Link key={b.id} href={`/bills/${b.id}`} className="kicker text-ink underline decoration-rule underline-offset-4 hover:text-ink-2">
                          {b.identifier}
                        </Link>
                      ))}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

type BillSectionProps = { title: string; rows: Awaited<ReturnType<typeof getCommittee>>["bills"]; closed?: boolean; canTrack?: boolean };

function BillSection({ title, rows, closed, canTrack }: BillSectionProps) {
  if (!rows.length) return null;
  return (
    <Section title={title} meta={`${rows.length} ${rows.length === 1 ? "bill" : "bills"}`}>
      <BillList morph compact asideBelow={canTrack} closed={closed} rows={rows.map((b) => ({ id: b.id, identifier: b.identifier, title: b.title,
        status: b.status, sub: [b.primarySponsor, b.referredAt ? `Referred ${shortDate(b.referredAt)}` : null].filter(Boolean).join(" · "),
        lastActionAt: b.lastActionAt, lastActionText: b.lastActionText, position: b.position, result: b.statusText,
        aside: canTrack ? <PositionButtons billId={b.id} identifier={b.identifier} position={b.position} /> : undefined }))} />
    </Section>
  );
}
