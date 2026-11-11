import Link from "next/link";
import { ViewTransition, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { cn, Status, type Tone } from "@/components/ui";
import type { DistrictView } from "@/server/services/center";
import { fullDate, nowMs, shortDate, waited } from "@/lib/format";
import { AskButtons, SenderButtons } from "./controls";
import { Marked, Waiting } from "./live";

export { Marked };

export const ROOT = "/constituent-center";
export const mailHref = (id: string) => `${ROOT}/mail/${id}`;
export const DISTRICT_VIEWS: Record<DistrictView, string> = { in: "In district", outside: "Outside", unknown: "Not known" };

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="kicker inline-flex items-center gap-2 text-ink transition-colors hover:text-ink-2">
      <ArrowLeft aria-hidden className="size-4 text-rule" strokeWidth={2} />
      {children}
    </Link>
  );
}

export function PageTitle({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cn("pt-6 lg:pt-8", className)}>
      <h1 className="anchor text-[60px] text-ink lg:text-[96px]">{title}</h1>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

const ROW_MOVE = { list: "row-move", default: "none" };
const ROW_OUT = { list: "row-out", default: "none" };

export function Block({ title, id, children }: { title: ReactNode; id?: string; children: ReactNode }) {
  return (
    <ViewTransition update={ROW_MOVE} default="none">
      <section id={id} className="mt-14 scroll-mt-8">
        <h2 className="rail-title text-[40px] text-ink lg:text-[48px]">{title}</h2>
        <div className="mt-3">{children}</div>
      </section>
    </ViewTransition>
  );
}

const TRUST: Record<string, { label: string; tone: Tone }> = {
  verified: { label: "Sender confirmed", tone: "neutral" },
  relay: { label: "Sent through an advocacy platform", tone: "neutral" },
  unverified: { label: "Sender not confirmed", tone: "warn" },
  failed: { label: "May be forged", tone: "danger" },
  unknown: { label: "Sender not checked", tone: "warn" },
};

export const trustInfo = (trust: string) => TRUST[trust] ?? TRUST.unknown;

const DISTRICT_WORD: Record<string, { label: string; tone: Tone }> = {
  in_district: { label: "In district", tone: "ok" },
  outside: { label: "Outside the district", tone: "neutral" },
  out_of_state: { label: "Out of state", tone: "neutral" },
};

export function DistrictWord({ status }: { status: string | null | undefined }) {
  const d = status ? DISTRICT_WORD[status] : null;
  return d ? <Status tone={d.tone}>{d.label}</Status> : null;
}

export function TrustWord({ trust }: { trust: string }) {
  const t = trustInfo(trust);
  return <Status tone={t.tone}>{t.label}</Status>;
}

export function Letter({ text, spans }: { text: string; spans: { start: number; end: number }[] }) {
  const sorted = [...spans].filter((s) => s.end > s.start && s.end <= text.length).sort((a, b) => a.start - b.start);
  const pieces: ReactNode[] = [];
  let at = 0;
  sorted.forEach((s, i) => {
    if (s.end <= at) return;
    const start = Math.max(s.start, at);
    if (start > at) pieces.push(text.slice(at, start));
    pieces.push(<Marked key={i}>{text.slice(start, s.end)}</Marked>);
    at = s.end;
  });
  if (at < text.length) pieces.push(text.slice(at));
  return <div className="letter">{pieces}</div>;
}

export function NoRows({ children }: { children: ReactNode }) {
  return <p className="py-6 text-base text-ink-2">{children}</p>;
}

type AskItem = { id: string; kind: string; summary: string; quote: string; urgency: string; dueAt: Date | null; messageId: string; fromName: string | null;
  fromAddress: string; receivedAt: Date; senderTrust: string; assignee: string | null; districtStatus?: string | null };

function dueLabel(a: Pick<AskItem, "urgency" | "dueAt">) {
  if (a.dueAt) return `Due ${shortDate(a.dueAt)}`;
  return a.urgency === "urgent" ? "Urgent" : a.urgency === "soon" ? "Soon" : null;
}

export function WaitingSince({ at }: { at: Date }) {
  return <span title={fullDate(at)}><Waiting since={at.toISOString()} initial={waited(at, nowMs())} /></span>;
}

function Row({ who, when, children }: { who: ReactNode; when: ReactNode; children: ReactNode }) {
  return (
    <ViewTransition update={ROW_MOVE} exit={ROW_OUT} default="none">
      <li className="need-row border-b border-line py-5">
        <div className="need-who min-w-0 text-sm text-ink-2">{who}</div>
        <div className="need-what min-w-0">{children}</div>
        <div className="need-when text-sm text-ink-2">{when}</div>
      </li>
    </ViewTransition>
  );
}

const WHO = "text-base font-semibold break-words text-ink";

export function AskRows({ items, canTriage }: { items: AskItem[]; canTriage: boolean }) {
  return (
    <ul>
      {items.map((a) => {
        const due = dueLabel(a);
        return (
          <Row
            key={a.id}
            who={
              <>
                <p className={WHO}>{a.fromName ?? a.fromAddress}</p>
                <DistrictWord status={a.districtStatus} />
                {a.senderTrust !== "verified" && a.senderTrust !== "relay" && (
                  <p>
                    <TrustWord trust={a.senderTrust} />
                  </p>
                )}
                {a.assignee && <p className="hand">{a.assignee}</p>}
              </>
            }
            when={
              <>
                {due && (
                  <p>
                    <Status tone={a.urgency === "urgent" ? "danger" : "warn"}>{due}</Status>
                  </p>
                )}
                <p>
                  <WaitingSince at={a.receivedAt} />
                </p>
                {canTriage && <AskButtons id={a.id} className="mt-2" />}
              </>
            }
          >
            <Link href={mailHref(a.messageId)} className="text-lg font-semibold text-ink transition-colors hover:text-ink-2">{a.summary}</Link>
            <p className="mt-1.5 text-md text-ink"><Marked>{a.quote}</Marked></p>
          </Row>
        );
      })}
    </ul>
  );
}

type SenderItem = { id: string; reason: string; messageId: string | null; subject: string; fromName: string | null; fromAddress: string; receivedAt: Date;
  trust: string; claimedAddress: string | null };

export function SenderRows({ items, canManage }: { items: SenderItem[]; canManage: boolean }) {
  return (
    <ul>
      {items.map((s) => (
        <Row
          key={s.id}
          who={
            <>
              <p className={WHO}>{s.fromName ?? s.fromAddress}</p>
              <p>
                <TrustWord trust={s.trust} />
              </p>
            </>
          }
          when={
            <>
              <p>
                <WaitingSince at={s.receivedAt} />
              </p>
              {canManage && <SenderButtons messageId={s.messageId!} className="mt-2" />}
            </>
          }
        >
          <Link href={mailHref(s.messageId!)} className="text-lg font-semibold text-ink transition-colors hover:text-ink-2">{s.subject || "No subject"}</Link>
          <p className="mt-1 text-base text-ink-2">
            Says it is from {s.fromName ? `${s.fromName}, ` : ""}
            {s.fromAddress}
            {s.claimedAddress ? `. Replies would go to ${s.claimedAddress}` : ""}.
          </p>
        </Row>
      ))}
    </ul>
  );
}

export function NoteRows({ items }: { items: { id: string; note: string | null; fromName: string | null; fromAddress: string; receivedAt: Date }[] }) {
  return (
    <ul>
      {items.map((m) => (
        <Row key={m.id} who={<p className={WHO}>{m.fromName ?? m.fromAddress}</p>} when={<p title={fullDate(m.receivedAt)}>{shortDate(m.receivedAt)}</p>}>
          <Link href={mailHref(m.id)} className="text-md text-ink"><Marked>{m.note ?? ""}</Marked></Link>
        </Row>
      ))}
    </ul>
  );
}
