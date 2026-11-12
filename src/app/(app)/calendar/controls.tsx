"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/ui";
import type { OfficeEventInput } from "@/server/services/calendar";
import { addEventAction, deleteEventAction, updateEventAction } from "./actions";

const LINK = "text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink disabled:opacity-50";
const BLANK: OfficeEventInput = { title: "", date: "", time: "", location: "", note: "" };

type FormProps = {
  start: OfficeEventInput; submitLabel: string; onSubmit: (v: OfficeEventInput) => Promise<{ ok: boolean; error?: string }>;
  onDone: (saved?: OfficeEventInput) => void;
};

function EventForm({ start, submitLabel, onSubmit, onDone }: FormProps) {
  const [v, setV] = useState(start);
  const [error, setError] = useState<string | null>(null);
  const [pending, begin] = useTransition();
  const set = (k: keyof OfficeEventInput) => (e: { target: { value: string } }) => setV((old) => ({ ...old, [k]: e.target.value }));
  return (
    <form className="grid gap-x-6 gap-y-4 text-left sm:grid-cols-[minmax(0,1fr)_170px_130px]" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      begin(async () => {
        const r = await onSubmit(v);
        if (r.ok) onDone(v);
        else setError(r.error ?? "That did not save.");
      });
    }}>
      <Field label="What" htmlFor="event-title"><Input id="event-title" value={v.title} onChange={set("title")} required maxLength={200} /></Field>
      <Field label="Date" htmlFor="event-date"><Input id="event-date" type="date" value={v.date} onChange={set("date")} required /></Field>
      <Field label="Time" htmlFor="event-time"><Input id="event-time" type="time" value={v.time ?? ""} onChange={set("time")} /></Field>
      <Field label="Where" htmlFor="event-where"><Input id="event-where" value={v.location ?? ""} onChange={set("location")} maxLength={200} /></Field>
      <div className="sm:col-span-2">
        <Field label="Note" htmlFor="event-note"><Input id="event-note" value={v.note ?? ""} onChange={set("note")} maxLength={2000} /></Field>
      </div>
      <div className="flex items-center gap-3 sm:col-span-3">
        <Button type="submit" variant="primary" disabled={pending || !v.title.trim() || !v.date}>{submitLabel}</Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={() => onDone()}>Cancel</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </form>
  );
}

export function AddEvent({ day, scope, from, to }: { day: string; scope?: string; from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  if (!open) return <Button type="button" onClick={() => setOpen(true)}>Add your own</Button>;
  // An entry outside the two weeks on screen moves the page to the weeks that hold it.
  const done = (saved?: OfficeEventInput) => {
    setOpen(false);
    if (saved && (saved.date < from || saved.date > to)) router.push(`/calendar?start=${saved.date}${scope ? `&scope=${scope}` : ""}`);
  };
  return (
    <div className="mx-auto w-full max-w-[760px] pt-2">
      <EventForm start={{ ...BLANK, date: day }} submitLabel="Add" onSubmit={addEventAction} onDone={done} />
    </div>
  );
}

export function OwnEventControls({ id, event }: { id: string; event: OfficeEventInput }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, begin] = useTransition();
  if (editing) {
    return (
      <div className="mt-4 max-w-[760px]">
        <EventForm start={event} submitLabel="Save" onSubmit={(v) => updateEventAction(id, v)} onDone={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <p className="mt-2 flex items-center gap-5">
      <button type="button" className={LINK} disabled={pending} onClick={() => setEditing(true)}>Change</button>
      <button type="button" className={LINK} disabled={pending} aria-label={`Remove ${event.title}`} onClick={() => begin(async () => {
        const r = await deleteEventAction(id);
        setError(r.ok ? null : r.error);
      })}>
        Remove
      </button>
      {error && <span role="alert" className="text-sm text-danger">{error}</span>}
    </p>
  );
}
