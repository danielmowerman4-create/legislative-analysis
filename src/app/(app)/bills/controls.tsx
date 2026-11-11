"use client";

import { useEffect, useId, useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellRing, Link2, X } from "lucide-react";
import { Button, cn, Input, Select, Textarea } from "@/components/ui";
import type { BillPosition, BillPriority } from "@/server/db/schema";
import { PositionStamp } from "@/components/stamp";
import { PenCircle } from "@/components/marks";
import {
  billNoteAction,
  findBillsAction,
  followAction,
  linkBillAction,
  setPositionAction,
  trackBillsAction,
  unlinkBillAction,
  untrackAction,
  updateTrackingAction,
} from "./actions";

const PRIORITIES: [BillPriority, string][] = [
  ["high", "High"],
  ["normal", "Normal"],
  ["low", "Low"],
];

const POSITION_WORDS: [BillPosition, string][] = [
  ["support", "Support"],
  ["oppose", "Oppose"],
  ["neutral", "Neutral"],
  ["watching", "Watch"],
];

type PositionButtonsProps = { billId: string; identifier: string; position: BillPosition | null; large?: boolean; noStamp?: boolean };

export function PositionButtons({ billId, identifier, position, large, noStamp }: PositionButtonsProps) {
  const [value, setValue] = useOptimistic(position);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false);
  const choose = (next: BillPosition) => {
    if (next === value) return;
    setChosen(true);
    start(async () => {
      setValue(next);
      const r = await setPositionAction(billId, next);
      setError(r.ok ? null : r.error);
    });
  };
  return (
    <span className={cn("inline-flex max-w-full", large ? "flex-wrap items-center justify-center gap-x-8 gap-y-3" : "flex-col items-end")}>
      <span role="group" aria-label={`Your office's position on ${identifier}`}
        className={cn("relative", large ? "flex flex-wrap items-center justify-center gap-x-4 gap-y-1 sm:gap-x-6" : "grid w-[288px] max-w-full grid-cols-4")}>
        {POSITION_WORDS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={value === key}
            disabled={pending}
            onClick={() => choose(key)}
            className={cn("group/oval relative whitespace-nowrap transition-colors duration-150 disabled:cursor-progress",
              large ? "rail-title flex h-11 items-center gap-1.5 text-[23px] text-ink sm:gap-2 sm:text-[25px]"
              : cn("h-10 text-sm", value === key ? "text-ink" : "text-ink-2 hover:text-ink"))}
          >
            {large && <span aria-hidden className="ballot-oval" data-on={value === key || undefined} />}
            {label}
            {value === key && !large && <PenCircle key={key} seed={billId + key} draw={chosen} />}
          </button>
        ))}
      </span>
      {value && !noStamp && (
        <PositionStamp key={value} position={value} seed={billId} fresh={chosen} large={large} decorative className={large ? undefined : "mt-2 mr-1.5"} />
      )}
      {error && <span role="alert" className="text-sm text-danger">{error}</span>}
    </span>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col"><span className="text-sm font-semibold text-ink">{label}</span>{children}</label>
  );
}

type Tracking = { position: BillPosition; priority: BillPriority; reason: string | null; assignedTo: string | null; nextStep: string | null;
  dueDate: string | null };
type Companion = { id: string; identifier: string; tracked: boolean };
type Member = { userId: string; name: string };

export function OfficePanel({ billId, tracking, team, companions }: { billId: string; tracking: Tracking | null; team: Member[]; companions: Companion[] }) {
  if (!tracking) {
    return <p className="text-sm text-ink-2">Choose Support, Oppose, Neutral or Watch at the top of this page to add the bill to your tracked list.</p>;
  }
  return <OfficeForm billId={billId} tracking={tracking} team={team} companions={companions} />;
}

function OfficeForm({ billId, tracking, team, companions }: { billId: string; tracking: Tracking; team: Member[]; companions: Companion[] }) {
  const router = useRouter();
  const [priority, setPriority] = useState<BillPriority>(tracking.priority);
  const [reason, setReason] = useState(tracking.reason ?? "");
  const [assignedTo, setAssignedTo] = useState(tracking.assignedTo ?? "");
  const [nextStep, setNextStep] = useState(tracking.nextStep ?? "");
  const [dueDate, setDueDate] = useState(tracking.dueDate ?? "");
  const [also, setAlso] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const touched = () => setSaved(false);

  const save = () =>
    start(async () => {
      const r = await updateTrackingAction(billId,
        { priority, reason: reason.trim() || null, assignedTo: assignedTo || null, nextStep: nextStep.trim() || null, dueDate: dueDate || null });
      if (r.ok && also.length) {
        const c = await trackBillsAction(also, { position: tracking.position, priority, reason: reason.trim() || null });
        if (!c.ok) {
          setError(c.error);
          return;
        }
      }
      if (r.ok) {
        setError(null);
        setSaved(true);
        setAlso([]);
        router.refresh();
      } else setError(r.error);
    });
  const stop = () =>
    start(async () => {
      const r = await untrackAction(billId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onChange={touched}
    >
      <Labeled label="Priority">
        <Select value={priority} onChange={(e) => setPriority(e.target.value as BillPriority)} className="w-full">
          {PRIORITIES.map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </Select>
      </Labeled>
      <Labeled label="Why the office tracks it">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="How it affects the district" className="w-full" />
      </Labeled>
      <Labeled label="Handled by">
        <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="w-full">
          <option value="">No one yet</option>
          {team.map((m) => (
            <option key={m.userId} value={m.userId}>{m.name}</option>
          ))}
        </Select>
      </Labeled>
      <Labeled label="Next step">
        <Input value={nextStep} onChange={(e) => setNextStep(e.target.value)} maxLength={300} placeholder="Call the lead sponsor" className="w-full" />
      </Labeled>
      <Labeled label="Due"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full" /></Labeled>
      {companions.length > 0 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-semibold text-ink">Also apply to the companion bill</legend>
          {companions.map((c) => (
            <label key={c.id} className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={also.includes(c.id)}
                onChange={(e) => setAlso((xs) => (e.target.checked ? [...xs, c.id] : xs.filter((x) => x !== c.id)))} />
              <span className="font-semibold">{c.identifier}</span>
              {c.tracked && <span className="text-ink-3">already tracked</span>}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">{error}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="submit" variant="primary" disabled={pending}>Save</Button>
        {saved && !pending && <span role="status" className="text-sm font-semibold text-ok">Saved</span>}
        <button type="button" onClick={stop} disabled={pending}
          className="ml-auto h-10 text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink disabled:opacity-50">
          Stop tracking
        </button>
      </div>
    </form>
  );
}

export function FollowButton({ billId, followed }: { billId: string; followed: boolean }) {
  const [f, setF] = useOptimistic(followed);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={f}
      title={error ?? "Notify me personally about new actions on this bill"}
      onClick={() =>
        start(async () => {
          setF(!f);
          const r = await followAction(billId, !f);
          setError(r.ok ? null : r.error);
        })
      }
      className="kicker group inline-flex items-center gap-2 whitespace-nowrap text-ink transition-colors duration-150 hover:text-ink-2 disabled:cursor-progress"
    >
      {f ? "Notifying you" : "Notify me"}
      {f ? <BellRing aria-hidden className="size-4 text-rule" strokeWidth={2} /> : <Bell aria-hidden className="size-4 text-rule" strokeWidth={2} />}
    </button>
  );
}

export function NoteForm({ billId }: { billId: string }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await billNoteAction(billId, body);
        if (r.ok) setBody("");
        else setError(r.error);
      });
    }}>
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Add a note for the office" aria-label="Bill note" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div>
        <Button type="submit" disabled={pending || !body.trim()}>Add note</Button>
      </div>
    </form>
  );
}

type Found = { id: string; identifier: string; title: string; session: string };

type BillPickerProps = { label: string; exclude?: string[]; onPick: (b: Found) => void; initial?: Found | null; solid?: boolean };

export function BillPicker({ label, exclude, onPick, initial, solid }: BillPickerProps) {
  const [q, setQ] = useState(initial ? `${initial.identifier} ${initial.title}` : "");
  const [results, setResults] = useState<Found[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const uid = useId();

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || !open) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const r = await findBillsAction(term);
      if (mine === seq.current && r.ok) {
        setResults((r.data ?? []).filter((b) => !exclude?.includes(b.id)));
        setActive(0);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, open, exclude]);

  const pick = (b: Found) => {
    setQ(`${b.identifier} ${b.title}`);
    setOpen(false);
    onPick(b);
  };

  return (
    <div className="relative">
      <label htmlFor={`${uid}-q`} className="kicker block text-ink-2">{label}</label>
      <div className={solid ? "paper mt-2" : undefined}>
      <Input
        solid={solid}
        className={solid ? "w-full" : undefined}
        id={`${uid}-q`}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        value={q}
        placeholder="Type a bill number or title"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            pick(results[active]);
          }
        }}
      />
      </div>
      {open && results.length > 0 && (
        <ul id={`${uid}-list`} role="listbox" className="paper absolute z-30 max-h-80 w-full overflow-y-auto py-1 shadow-pop scroll-thin">
          {results.map((b, i) => (
            <li
              key={b.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(b);
              }}
              className={cn("flex cursor-pointer items-baseline gap-3 px-4 py-2.5 text-sm", i === active && "bg-surface-2")}
            >
              <span className="kicker whitespace-nowrap text-ink">{b.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{b.title}</span>
              <span className="text-ink-3">{b.session}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LinkBillForm({ billId }: { billId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState<Found | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}><Link2 className="size-4" strokeWidth={1.75} />Link a bill</Button>;
  return (
    <form className="flex w-full flex-col gap-5 border-y border-line py-5 sm:flex-row sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      if (!other) return;
      start(async () => {
        const r = await linkBillAction(billId, other.id, note);
        if (r.ok) {
          setOpen(false);
          setOther(null);
          setNote("");
          router.refresh();
        } else setError(r.error);
      });
    }}>
      <div className="min-w-0 flex-1"><BillPicker label="Bill to link" exclude={[billId]} onPick={setOther} /></div>
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="kicker text-ink-2">How they relate</span>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Competing bill" />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!other || pending}>Link</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}

export function UnlinkButton({ billId, otherId, identifier }: { billId: string; otherId: string; identifier: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Remove your office's link to ${identifier}`}
      title="Remove your office's link"
      onClick={() => start(async () => { const r = await unlinkBillAction(billId, otherId); if (r.ok) router.refresh(); })}
      className="grid size-7 place-items-center text-ink-3 hover:text-danger"
    >
      <X className="size-4" />
    </button>
  );
}

export function TrackingExtras({ billId, identifier, priority }: { billId: string; identifier: string; priority: BillPriority }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const update = (next: BillPriority) =>
    start(async () => {
      const r = await updateTrackingAction(billId, { priority: next });
      if (r.ok) router.refresh();
    });
  const stop = () =>
    start(async () => {
      const r = await untrackAction(billId);
      if (r.ok) router.refresh();
    });
  return (
    <span className="flex items-center gap-4 md:justify-end">
      <label className="flex items-center gap-2">
        <span className="text-sm text-ink-3">Priority</span>
        <Select aria-label={`Priority of ${identifier}`} value={priority} disabled={pending} onChange={(e) => update(e.target.value as BillPriority)}
          className="h-9 w-[96px]">
          {PRIORITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
      </label>
      <button type="button" disabled={pending} onClick={stop} aria-label={`Stop tracking ${identifier}`}
        className="h-9 text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink disabled:opacity-50">
        Stop tracking
      </button>
    </span>
  );
}
