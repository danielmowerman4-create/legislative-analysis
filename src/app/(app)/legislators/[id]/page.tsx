import type { Metadata } from "next";
import Link from "next/link";
import { orNotFound, requireOffice } from "@/server/auth/next";
import { getLegislator, sessionState } from "@/server/services/legislation";
import type { BillStatus } from "@/server/db/schema";
import { ActionLink, Breadcrumbs, cn, EmptyState, PageHeader, SepList } from "@/components/ui";
import { Mail, Phone } from "lucide-react";
import { can } from "@/server/authz/context";
import { PositionButtons } from "../../bills/controls";
import { Section } from "@/components/ui/blocks";
import { BillLine, BillList, CHAMBER, PositionMark } from "@/components/bills";
import { dateOnly } from "@/lib/format";
import { isPassageVote, voteOutcome } from "@/server/legislation/scoring";

export const metadata: Metadata = { title: "Legislator" };

const VOTE_LABEL: Record<string, string> = { yes: "Yes", no: "No", not_voting: "Not voting", absent: "Absent", excused: "Excused", other: "Other" };
const PARTY: Record<string, string> = { R: "Republican", D: "Democrat", I: "Independent" };

const VOTE_PREVIEW = 25;

export default async function LegislatorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ votes?: string }> }) {
  const { ctx } = await requireOffice();
  const { id } = await params;
  const { votes: voteView } = await searchParams;
  const [{ legislator: l, sponsored, votes }, session] = await orNotFound(Promise.all([getLegislator(ctx, id), sessionState(ctx)]));
  const canTrack = can(ctx, "legislation.track");
  const led = sponsored.filter((s) => s.sponsorType === "primary");
  const co = sponsored.filter((s) => s.sponsorType !== "primary");
  const counts = led.reduce<Partial<Record<BillStatus, number>>>((acc, b) => ({ ...acc, [b.status]: (acc[b.status] ?? 0) + 1 }), {});
  const pending = (counts.introduced ?? 0) + (counts.in_committee ?? 0) + (counts.passed_chamber ?? 0) + (counts.passed_both ??
    0) + (counts.sent_to_executive ?? 0);
  const failed = (counts.failed ?? 0) + (counts.vetoed ?? 0);
  const coEnacted = co.filter((b) => b.status === "enacted").length;
  const outcomes = votes.filter((v) => isPassageVote(v.motion)).map((v) => voteOutcome(v.position, v.vote));
  const withOffice = outcomes.filter((o) => o === "with").length;
  const counted = withOffice + outcomes.filter((o) => o === "against").length;
  const party = l.party ? (PARTY[l.party.slice(0, 1).toUpperCase()] ?? l.party) : null;
  const partyTone = party === "Republican" ? "text-party-r" : party === "Democrat" ? "text-party-d" : "";
  const listedVotes = voteView === "all" ? votes : votes.slice(0, VOTE_PREVIEW);
  const meta = [party, l.chamber ? CHAMBER[l.chamber] : null, l.district ? `District ${l.district}` : null, l.title].filter(Boolean);

  return (
    <>
      <PageHeader
        title={l.name}
        actions={
          l.contact.email || l.contact.phone ? (
            <>
              {l.contact.email && (
                <ActionLink plain href={`mailto:${l.contact.email}`} icon={Mail}>Email</ActionLink>
              )}
              {l.contact.phone && <ActionLink plain href={`tel:+1${l.contact.phone.replace(/\D/g, "")}`} icon={Phone}>{l.contact.phone}</ActionLink>}
            </>
          ) : undefined
        }
        crumbs={<Breadcrumbs items={[{ label: "Legislators", href: "/legislators" }, { label: l.name }]} />}
        meta={
          <SepList center>
            {meta.map((x) => (
              <span key={String(x)} className={x === party && party ? partyTone : ""}>{x}</span>
            ))}
          </SepList>
        }
      >
        <SepList center className="tabular pb-8 text-base text-ink-2">
          <span>
            <span className="font-semibold text-ink">{led.length}</span> bills led
          </span>
          {led.length > 0 && (
            <span>
              <span className={cn("font-semibold", counts.enacted ? "text-ok" : "text-ink")}>{counts.enacted ?? 0}</span> became law
            </span>
          )}
          {led.length > 0 && !session?.closed && (
            <span>
              <span className="font-semibold text-ink">{pending}</span> still moving
            </span>
          )}
          {led.length > 0 && (
            <span>
              <span className={cn("font-semibold", failed ? "text-danger" : "text-ink")}>{failed}</span> did not pass or vetoed
            </span>
          )}
          <span>
            <span className="font-semibold text-ink">{co.length}</span> co-sponsored
          </span>
          {co.length > 0 && led.length === 0 && (
            <span>
              <span className={cn("font-semibold", coEnacted ? "text-ok" : "text-ink")}>{coEnacted}</span> became law
            </span>
          )}
          {counted > 0 && (
            <span>
              <span className="font-semibold text-ink">{withOffice} of {counted}</span>{" "}
              votes with your office
            </span>
          )}
          {l.contact.office && <span>{l.contact.office}</span>}
        </SepList>
      </PageHeader>
      <div className="wrap">
        {l.committeeRoles.length > 0 && (
          <Section title="Committees">
            <ul className="grid gap-x-10 border-t border-line sm:grid-cols-2">
              {l.committeeRoles.map((r) => (
                <li key={r.committee} className="flex items-baseline justify-between gap-x-4 border-b border-line py-3">
                  <span className="text-base font-semibold text-ink">{r.committee}</span>
                  {r.role !== "Member" && <span className="text-sm whitespace-nowrap text-ink-2">{r.role}</span>}
                </li>
              ))}
            </ul>
          </Section>
        )}
        <SponsoredSection title="Bills led" rows={led} closed={session?.closed} canTrack={canTrack} />
        <SponsoredSection title="Co-sponsored" rows={co} closed={session?.closed} canTrack={canTrack} />
        {sponsored.length === 0 && <EmptyState title="No sponsored bills on record." />}
        <Section title="Recorded votes" meta={`${votes.length} ${votes.length === 1 ? "vote" : "votes"}`}>
          {votes.length === 0 ? (
            <p className="border-y border-line py-5 text-sm text-ink-3">
              {l.provider === "ctga" ? "No recorded votes." : "No member votes on record for tracked bills."}
            </p>
          ) : (
            <>
            <ul className="flex flex-col">
              {listedVotes.map((v, i) => (
                <BillLine
                  key={i}
                  href={`/bills/${v.billId}?tab=votes`}
                  identifier={v.identifier}
                  title={v.title}
                  note={`${v.motion}, ${v.voteDate ? dateOnly(v.voteDate) : "date not recorded"}`}
                  right={
                    <>
                      <span className={cn("text-sm font-semibold whitespace-nowrap", v.vote === "yes" || v.vote === "no" ? "text-ink" : "text-ink-3")}>
                        Voted {VOTE_LABEL[v.vote]}
                      </span>
                      <span className={cn("tabular text-sm whitespace-nowrap", v.passed ? "text-ok" : v.passed === false ? "text-danger" : "text-ink-2")}>
                        {v.passed ? "Passed" : v.passed === false ? "Failed" : "Result not recorded"} {v.yes}-{v.no}
                      </span>
                      <PositionMark position={v.position} />
                    </>
                  }
                />
              ))}
            </ul>
            {listedVotes.length < votes.length && (
              <Link href={`/legislators/${id}?votes=all`}
                className="mt-4 inline-block text-base font-semibold text-ink underline decoration-line-strong underline-offset-4">
                All {votes.length} votes
              </Link>
            )}
            </>
          )}
        </Section>
      </div>
    </>
  );
}

type SponsoredSectionProps = { title: string; rows: Awaited<ReturnType<typeof getLegislator>>["sponsored"]; closed?: boolean; canTrack?: boolean };

function SponsoredSection({ title, rows, closed, canTrack }: SponsoredSectionProps) {
  if (!rows.length) return null;
  return (
    <Section title={title} meta={`${rows.length} ${rows.length === 1 ? "bill" : "bills"}`}>
      <BillList morph compact asideBelow={canTrack} closed={closed} rows={rows.map((b) => ({ aside: canTrack
        ? <PositionButtons billId={b.id} identifier={b.identifier} position={b.position} /> : undefined, id: b.id, identifier: b.identifier, title: b.title,
        status: b.status, result: b.statusText, sub: b.session, lastActionAt: b.lastActionAt, lastActionText: b.lastActionText, position: b.position }))} />
    </Section>
  );
}
