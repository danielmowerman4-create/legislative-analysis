"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import type { BillAlertKind } from "@/server/db/schema";
import { addAlertRuleAction, deleteAlertRuleAction, setAlertRuleActiveAction } from "./actions";

const KINDS: [BillAlertKind, string, string][] = [
  ["keyword", "Keyword", "Words in a bill's title or summary"],
  ["code", "Code section", "20-2 or 20-2-161"],
  ["subject", "Subject", ""],
  ["sponsor", "Sponsor", "Member's name"],
];

export function AddAlertForm({ subjects }: { subjects: string[] }) {
  const [kind, setKind] = useState<BillAlertKind>("keyword");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [, label, placeholder] = KINDS.find((k) => k[0] === kind)!;
  return (
    <form className="grid gap-x-6 gap-y-4 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      start(async () => {
        const r = await addAlertRuleAction(kind, value);
        if (r.ok) setValue("");
        else setError(r.error);
      });
    }}>
      <Field label="Watch for" htmlFor="alert-kind">
        <Select id="alert-kind" value={kind} onChange={(e) => {
          setKind(e.target.value as BillAlertKind);
          setValue("");
        }}>
          {KINDS.map(([k, l]) => (
            <option key={k} value={k}>{l}</option>
          ))}
        </Select>
      </Field>
      <Field label={label} htmlFor="alert-value">
        {kind === "subject" ? (
          <Select id="alert-value" value={value} onChange={(e) => setValue(e.target.value)} required>
            <option value="">Choose a subject</option>
            {subjects.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        ) : (
          <Input id="alert-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} required maxLength={120} />
        )}
      </Field>
      <Button type="submit" variant="primary" disabled={pending || !value.trim()}>Add alert</Button>
      {error && <p role="alert" className="text-sm text-danger sm:col-span-3">{error}</p>}
    </form>
  );
}

export function AlertRuleControls({ id, active, value }: { id: string; active: boolean; value: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "That did not save."));
    });
  return (
    <span className="flex items-center gap-5 text-sm">
      {error && <span className="text-danger">{error}</span>}
      <button type="button" disabled={pending} onClick={() => run(() => setAlertRuleActiveAction(id, !active))}
        className="text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink">
        {active ? "Pause" : "Resume"}
      </button>
      <button type="button" disabled={pending} aria-label={`Delete the alert for ${value}`} onClick={() => run(() => deleteAlertRuleAction(id))}
        className="text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-danger">
        Delete
      </button>
    </span>
  );
}
