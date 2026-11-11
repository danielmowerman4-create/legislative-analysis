import { BillKicker, BillTitle, PartyMark, PositionMark, PriorityMark } from "@/components/bills";
import { cn } from "@/components/ui";
import { citationLabel, isSection } from "@/server/legislation/related";
import { isPassageVote, isVoiceVote } from "@/server/legislation/scoring";
import type { getBillDetail } from "@/server/services/legislation";
import { dateOnly, relative, shortDate } from "@/lib/format";

type Detail = Awaited<ReturnType<typeof getBillDetail>>;

export function BillBrief({ d, noRollCalls, full, assignee }: { d: Detail; noRollCalls: boolean; full?: boolean; assignee?: string | null }) {
  const sponsorLimit = full ? 16 : 8;
  const recent = d.actions.slice(0, full ? 8 : 3);
  const codes = full ? d.bill.codeSections.filter(isSection).slice(0, 12) : [];
  const votes = [...d.votes.filter((v) => isPassageVote(v.motion)), ...d.votes.filter((v) => !isPassageVote(v.motion))].slice(0, full ? 8 : 4);
  const columns = noRollCalls ? "md:grid-cols-2 print:grid-cols-2" : "md:grid-cols-3 print:grid-cols-3";
  return (
    <section className={cn("mt-8 border-t-2 border-ink pt-5", !full && "break-inside-avoid")}>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-1">
        <div className="min-w-0 flex-1 basis-96">
          <BillKicker identifier={d.bill.identifier} status={d.bill.status} billType={d.bill.billType} />
          <BillTitle className="mt-1 block text-lg">{d.bill.title}</BillTitle>
        </div>
        {d.tracking ? (
          <span className="flex items-center gap-3">
            <PriorityMark priority={d.tracking.priority} withLabel />
            <PositionMark position={d.tracking.position} className="text-md" />
          </span>
        ) : (
          <span className="text-sm text-ink-3">Not tracked</span>
        )}
      </div>
      {full && d.bill.statusText && <p className="mt-2 text-sm font-semibold text-ink">{d.bill.statusText}</p>}
      {d.bill.officialSummary && <p className="mt-2 max-w-[80ch] text-sm text-ink-2">{d.bill.officialSummary}</p>}
      {d.tracking?.reason && (
        <p className="mt-2 text-sm text-ink"><span className="font-semibold">Why we track it: </span>{d.tracking.reason}</p>
      )}
      {full && (d.tracking?.nextStep || assignee) && (
        <p className="mt-2 text-sm text-ink">
          {d.tracking?.nextStep && (
            <>
              <span className="font-semibold">Next step: </span>
              {d.tracking.nextStep}
              {d.tracking.dueDate ? `, due ${dateOnly(d.tracking.dueDate)}` : ""}.{" "}
            </>
          )}
          {assignee && (
            <>
              <span className="font-semibold">Handled by: </span>
              {assignee}
            </>
          )}
        </p>
      )}

      <div className={cn("mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5", columns)}>
        <div>
          <h3 className="kicker mb-1.5 text-ink-3">Sponsors</h3>
          <ul className="text-sm">
            {d.sponsors.slice(0, sponsorLimit).map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-3">
                <span className={cn("min-w-0 truncate", s.sponsorType === "primary" ? "font-semibold text-ink" : "text-ink")}>{s.name}</span>
                <PartyMark party={s.party} district={s.district} />
              </li>
            ))}
            {d.sponsors.length > sponsorLimit && <li className="text-ink-3">and {d.sponsors.length - sponsorLimit} more</li>}
          </ul>
        </div>
        <div>
          <h3 className="kicker mb-1.5 text-ink-3">Recent actions</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {recent.map((a) => (
              <li key={a.id}><span className="tabular text-ink-3">{shortDate(a.actionDate)}</span> <span className="text-ink">{a.description}</span></li>
            ))}
          </ul>
        </div>
        {!noRollCalls && (
          <div>
            <h3 className="kicker mb-1.5 text-ink-3">Votes so far</h3>
            <ul className="flex flex-col gap-1 text-sm">
              {votes.map((v) => (
                <li key={v.id}>
                  <span className="text-ink">{v.motion}</span>{" "}
                  <span className="tabular whitespace-nowrap text-ink-2">
                    {isVoiceVote(v) ? "voice vote" : `${v.yes}-${v.no}`}
                    {v.voteDate ? `, ${dateOnly(v.voteDate)}` : ""}
                  </span>
                </li>
              ))}
              {d.votes.length === 0 && <li className="text-ink-3">No votes yet</li>}
            </ul>
          </div>
        )}
      </div>

      {full && (d.committees.length > 0 || codes.length > 0) && (
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-5 md:grid-cols-2 print:grid-cols-2">
          {d.committees.length > 0 && (
            <div>
              <h3 className="kicker mb-1.5 text-ink-3">Committees</h3>
              <p className="text-sm text-ink">{d.committees.map((c) => c.name).join(", ")}</p>
            </div>
          )}
          {codes.length > 0 && (
            <div>
              <h3 className="kicker mb-1.5 text-ink-3">Statutes it changes</h3>
              <p className="text-sm text-ink">{codes.map(citationLabel).join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {d.notes.length > 0 && (
        <div className="mt-4">
          <h3 className="kicker mb-1.5 text-ink-3">Office notes</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {d.notes.slice(0, full ? 8 : 3).map((n) => (
              <li key={n.id} className="max-w-[80ch]">
                <span className="whitespace-pre-wrap text-ink">{n.body}</span>{" "}
                <span className="whitespace-nowrap text-ink-3">{n.author ?? "Staff"}, {relative(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
