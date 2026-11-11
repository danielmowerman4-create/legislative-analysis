import Link from "next/link";
import { Fragment, ViewTransition, type ReactNode } from "react";
import { Flag } from "lucide-react";
import { ActionLink, cn, Sep } from "@/components/ui";
import { PenCross } from "@/components/marks";
import type { BillPosition, BillPriority, BillStatus } from "@/server/db/schema";
import type { Outcome, Stage } from "@/server/legislation/stages";
import { isSimpleResolution } from "@/server/legislation/stages";
import { STATUS_LABEL } from "@/server/legislation/normalize";
import { dateOnly, eventTime, shortDate } from "@/lib/format";

export function BillNumber({ identifier, className }: { identifier: string; className?: string }) {
  return <span className={cn("kicker whitespace-nowrap text-ink", className)}>{identifier}</span>;
}

const POSITION: Record<BillPosition, { label: string; tone: string }> = {
  support: { label: "Support", tone: "text-support" },
  oppose: { label: "Oppose", tone: "text-oppose" },
  neutral: { label: "Neutral", tone: "text-neutral" },
  watching: { label: "Watching", tone: "text-ink-3" },
};

export function PositionMark({ position, className }: { position: BillPosition | null | undefined; className?: string }) {
  if (!position) return null;
  const p = POSITION[position];
  return <span className={cn("text-sm font-semibold whitespace-nowrap", p.tone, className)}>{p.label}</span>;
}

export function PriorityMark({ priority, withLabel }: { priority: BillPriority | null | undefined; withLabel?: boolean }) {
  if (priority !== "high") return withLabel && priority === "low" ? <span className="text-sm text-ink-3">Low priority</span> : null;
  return (
    <span className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-warn-ink" title="High priority">
      <Flag aria-hidden className="size-3.5" strokeWidth={2} fill="currentColor" />
      {withLabel ? "High priority" : <span className="sr-only">High priority</span>}
    </span>
  );
}

export function PartyMark({ party, district }: { party: string | null | undefined; district?: string | null }) {
  const p = (party ?? "").trim().toUpperCase().slice(0, 1);
  if (!p) return district ? <span className="text-sm text-ink-3">District {district}</span> : null;
  const tone = p === "R" ? "text-party-r" : p === "D" ? "text-party-d" : "text-ink-2";
  return (
    <span className="text-sm whitespace-nowrap tabular" title={p === "R" ? "Republican" : p === "D" ? "Democrat" : (party ?? undefined)}>
      {district ? (
        <>
          <span className={cn("font-semibold", tone)}>{p}</span>
          <span className="text-ink-3">-{district}</span>
        </>
      ) : (
        <>
          <span className="text-ink-3">(</span>
          <span className={cn("font-semibold", tone)}>{p}</span>
          <span className="text-ink-3">)</span>
        </>
      )}
    </span>
  );
}

export function stageWords(status: BillStatus, billType?: string) {
  const adopted = billType !== undefined &&
    ((isSimpleResolution(billType) && status === "passed_chamber") || (/^(HJ|SJ)$/i.test(billType) && status === "passed_both"));
  const dead = status === "failed" || status === "vetoed" || status === "withdrawn";
  return { label: adopted ? "Adopted" : STATUS_LABEL[status], tone: dead ? "text-danger" : adopted || status === "enacted" ? "text-ok" : "text-ink-2" };
}

function StageMeter({ status }: { status: BillStatus }) {
  const s = stageWords(status);
  return <span className={cn("text-sm whitespace-nowrap", s.tone)}>{s.label}</span>;
}

export function BillKicker({ identifier, status, billType }: { identifier: string; status?: BillStatus | null; billType?: string }) {
  const s = status ? stageWords(status, billType) : null;
  return (
    <span className="kicker block text-ink">
      {identifier}
      {s && (
        <>
          <Sep />
          <span className={s.tone}>{s.label}</span>
        </>
      )}
    </span>
  );
}

const splitIdentifier = (identifier: string) => {
  const m = identifier.match(/^(\D+?)\s*(\d[\w-]*)$/);
  return m ? [m[1], m[2]] : ["", identifier];
};

type BillAnchorProps = { identifier: string; status?: BillStatus | null; billType?: string; small?: boolean };

export function BillAnchor({ identifier, status, billType, small }: BillAnchorProps) {
  const [prefix, number] = splitIdentifier(identifier);
  const s = status ? stageWords(status, billType) : null;
  const size = small ? "text-[36px]" : "text-[46px] sm:text-[52px]";
  return (
    <span className="block min-w-0">
      <span className="kicker block leading-4 text-ink-2">{prefix}</span>
      <span className={cn("anchor block text-ink transition-colors duration-150 group-hover:text-accent", size)}>{number}</span>
      {s && <span className={cn("kicker mt-1 block leading-[18px]", s.tone)}>{s.label}</span>}
    </span>
  );
}

export function BillTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("font-sans text-lg leading-[27px] font-semibold text-ink decoration-rule decoration-2 underline-offset-4 group-hover:underline",
      className)}>
      {children}
    </span>
  );
}

export function BillRoad({ stages, outcome }: { stages: Stage[]; outcome: Outcome }) {
  const when = (s: Stage) => {
    if (s.state === "stopped" && outcome) return `${outcome.label}${outcome.date ? `, ${dateOnly(outcome.date)}` : ""}`;
    if (s.date) return dateOnly(s.date);
    return s.state === "current" ? "Next" : s.state === "done" ? "Date not recorded" : "";
  };
  return (
    <ol aria-label="Bill progress" className="grid auto-rows-fr grid-cols-1 gap-y-1 sm:grid-flow-col sm:auto-cols-fr sm:grid-cols-none">
      {stages.map((s) => {
        const date = when(s);
        const tone = s.state === "upcoming" ? "text-ink-3 opacity-70" : s.state === "stopped" ? "text-danger" : "text-ink";
        return (
          <li key={s.key} aria-current={s.state === "current" ? "step" : undefined} className="min-w-0 px-2 text-center">
            <span className={cn("rail-title flex items-center justify-center gap-2 text-[24px] lg:text-[28px]", tone)}>
              {s.state === "stopped" && <PenCross className="size-4 shrink-0" />}
              {s.label}
            </span>
            {date && <span className={cn("tabular mt-1 block text-sm", s.state === "stopped" ? "text-danger" : "text-ink-2")}>{date}</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function BillResult({ status, statusText }: { status: BillStatus; statusText: string | null }) {
  const text = statusText ?? STATUS_LABEL[status];
  return status === "enacted" ? <span className="marked">{text}</span> : text;
}

export function NextEvent({ at }: { at: string | Date | null | undefined }) {
  if (!at) return <span className="text-sm text-ink-3">None scheduled</span>;
  return <span className="tabular text-sm text-ink">{eventTime(at)}</span>;
}

function LastAction({ date, text }: { date: string | null; text: string | null }) {
  if (!date && !text) return <span className="text-sm text-ink-3">No actions recorded</span>;
  return (
    <span className="text-sm"><span className="text-ink">{text}</span> <span className="tabular whitespace-nowrap text-ink-3">{shortDate(date)}</span></span>
  );
}

export const CHAMBER = { upper: "Senate", lower: "House", joint: "Joint" } as Record<string, string>;

type Row = { id: string; identifier: string; title: string; status: BillStatus; billType?: string; sub?: ReactNode; lastActionAt?: string | null;
  lastActionText?: string | null; nextEvent?: string | null; result?: string | null; position?: BillPosition | null; priority?: BillPriority | null;
  aside?: ReactNode };

const FULL = "xl:grid-cols-[minmax(0,1fr)_170px_140px_288px]";
// Only a filter or sort moves rows; saving inside a row must not.
const LIST_MOVE = { list: "list-move", default: "none" };
const LIST_IN = { list: "list-in", default: "none" };
const LIST_OUT = { list: "list-out", default: "none" };

type BillListProps = { rows: Row[]; compact?: boolean; asideBelow?: boolean; closed?: boolean; morph?: boolean };

export function BillList({ rows, compact, asideBelow, closed, morph }: BillListProps) {
  const wide = !compact;
  return (
    <div>
      {wide && (
        <div aria-hidden className={cn("hidden gap-x-8 pb-1 xl:grid", FULL)}>
          <span className="kicker text-ink-3">Bill</span>
          <span className="kicker text-ink-3">Last action</span>
          <span className="kicker text-ink-3">{closed ? "Result" : "Next hearing"}</span>
          <span className="kicker text-center text-ink-3">Your position</span>
        </div>
      )}
      <ul>
        {rows.map((r) => {
          const row = (
            <li className={cn("rise-on-view grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 py-6", wide && `xl:gap-x-8 ${FULL}`)}>
              <Link href={`/bills/${r.id}`}
                className="group col-start-1 row-start-1 grid min-w-0 grid-cols-[66px_minmax(0,1fr)] gap-x-4 sm:grid-cols-[98px_minmax(0,1fr)]">
                <BillAnchor identifier={r.identifier} status={r.status} billType={r.billType} />
                <span className="min-w-0 pt-0.5">
                  {morph ? (
                    <ViewTransition name={`bill-title-${r.id}`} share="morph" default="none">
                      <BillTitle className="block text-pretty">{r.title}</BillTitle>
                    </ViewTransition>
                  ) : (
                    <BillTitle className="block text-pretty">{r.title}</BillTitle>
                  )}
                  {r.sub && <span className="mt-1 block text-sm text-ink-2">{r.sub}</span>}
                </span>
              </Link>
              <div className={cn("col-span-2 row-start-2 mt-2 pl-[82px] text-sm sm:pl-[114px]", asideBelow && "md:col-span-1",
                wide && "xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:mt-0 xl:pl-0")}>
                {(r.lastActionAt || r.lastActionText) && <span className={cn("text-ink-3", wide && "xl:hidden")}>Last action: </span>}
                <LastAction date={r.lastActionAt ?? null} text={r.lastActionText ?? null} />
              </div>
              {closed ? (
                r.result && (
                  <div className={cn("col-span-2 row-start-3 pl-[82px] text-sm text-ink sm:pl-[114px]", asideBelow && "md:col-span-1",
                    wide && "xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:pl-0")}>
                    <span className={cn("text-ink-3", wide && "xl:hidden")}>Result: </span>
                    {r.result}
                  </div>
                )
              ) : (
                <div className={cn("col-span-2 row-start-3 pl-[82px] text-sm sm:pl-[114px]", wide && "xl:col-span-1 xl:col-start-3 xl:row-start-1 xl:pl-0",
                  !r.nextEvent && (wide ? "hidden xl:block" : "hidden"))}>
                  {r.nextEvent && <span className={cn("text-ink-3", wide && "xl:hidden")}>Next hearing: </span>}
                  <NextEvent at={r.nextEvent} />
                </div>
              )}
              <div className={cn("flex items-start justify-end gap-2.5",
                asideBelow ? "col-span-2 row-start-4 mt-3 justify-start md:col-span-1 md:col-start-2 md:row-span-3 md:row-start-1 md:mt-0 md:justify-end"
                : "col-start-2 row-start-1", wide && "xl:col-span-1 xl:col-start-4 xl:row-start-1")}>
                {r.aside ?? (
                  <>
                    <PriorityMark priority={r.priority} />
                    <PositionMark position={r.position} />
                  </>
                )}
              </div>
            </li>
          );
          return morph ? (
            <ViewTransition key={r.id} name={`bill-row-${r.id}`} update={LIST_MOVE} share={LIST_MOVE} enter={LIST_IN} exit={LIST_OUT} default="none">
              {row}
            </ViewTransition>
          ) : (
            <Fragment key={r.id}>{row}</Fragment>
          );
        })}
      </ul>
    </div>
  );
}

type BillLineProps = { href: string; identifier: string; title: string; status?: BillStatus | null; note?: ReactNode; right?: ReactNode };

export function BillLine({ href, identifier, title, status, note, right }: BillLineProps) {
  return (
    <li className="rise-on-view grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 py-4">
      <Link href={href} className="group grid min-w-0 grid-cols-[66px_minmax(0,1fr)] gap-x-4 sm:grid-cols-[84px_minmax(0,1fr)]">
        <BillAnchor small identifier={identifier} status={status} />
        <span className="min-w-0 pt-0.5">
          <BillTitle className="block text-pretty">{title}</BillTitle>
          {note && <span className="mt-1 block text-sm text-ink-2">{note}</span>}
        </span>
      </Link>
      {right && <span className="flex flex-col items-end gap-0.5">{right}</span>}
    </li>
  );
}

type MeetingProps = { time: string | null; title: string; detail?: ReactNode; cancelled?: boolean; prepHref?: string; children?: ReactNode };

export function Meeting({ time, title, detail, cancelled, prepHref, children }: MeetingProps) {
  return (
    <li className={cn("grid gap-x-8 gap-y-1 py-6", time && "sm:grid-cols-[96px_minmax(0,1fr)]", cancelled && "opacity-60")}>
      {time && <span className="tabular pt-0.5 text-md font-semibold whitespace-nowrap text-ink">{time}</span>}
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h3 className="font-display text-lg font-medium text-ink">{title}</h3>
          {prepHref && <ActionLink href={prepHref}>Prep sheet</ActionLink>}
        </div>
        {detail && <p className="mt-0.5 text-sm text-ink-2">{detail}</p>}
        {children}
      </div>
    </li>
  );
}

type MeetingBillProps = { id: string; identifier: string; title: string; status?: BillStatus; position?: BillPosition | null; priority?: BillPriority | null;
  actions?: ReactNode };

export function MeetingBill({ id, identifier, title, status, position, priority, actions }: MeetingBillProps) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-5 gap-y-0.5 py-2.5">
      <Link href={`/bills/${id}`} className="group flex min-w-0 flex-[1_1_260px] items-baseline gap-3">
        <BillNumber identifier={identifier} className="w-[72px] shrink-0" />
        <span className="text-sm text-ink decoration-rule underline-offset-4 group-hover:underline">{title}</span>
      </Link>
      {status && <StageMeter status={status} />}
      {actions ?? (
        <span className="flex items-center gap-2"><PositionMark position={position} /><PriorityMark priority={priority} /></span>
      )}
    </li>
  );
}
