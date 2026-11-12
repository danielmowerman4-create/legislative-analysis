"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import type { PressKind } from "@/server/db/schema";
import { approvePressAction, createPressAction, deletePressAction, savePressAction } from "./actions";

const LINK = "text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-ink disabled:opacity-50";

type NewProps = { kinds: [PressKind, string][]; bills: { id: string; identifier: string; title: string }[] };

export function NewStatement({ kinds, bills }: NewProps) {
  const router = useRouter();
  const [kind, setKind] = useState<PressKind>("statement");
  const [billId, setBillId] = useState("");
  const [about, setAbout] = useState("");
  const [words, setWords] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form className="grid gap-x-6 gap-y-4 sm:grid-cols-[200px_minmax(0,1fr)]" onSubmit={(e) => {
      e.preventDefault();
      setError(null);
      start(async () => {
        const r = await createPressAction({ kind, billId: billId || null, about, words });
        if (r.ok && r.data) router.push(`/press/${r.data}`);
        else if (!r.ok) setError(r.error);
      });
    }}>
      <Field label="Kind" htmlFor="press-kind">
        <Select id="press-kind" value={kind} onChange={(e) => setKind(e.target.value as PressKind)}>
          {kinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </Select>
      </Field>
      <Field label="Bill" htmlFor="press-bill">
        <Select id="press-bill" value={billId} onChange={(e) => setBillId(e.target.value)}>
          <option value="">No bill</option>
          {bills.map((b) => <option key={b.id} value={b.id}>{b.identifier} {b.title.slice(0, 80)}</option>)}
        </Select>
      </Field>
      {!billId && (
        <div className="sm:col-span-2">
          <Field label="About" htmlFor="press-about"><Input id="press-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={160} /></Field>
        </div>
      )}
      <div className="sm:col-span-2">
        <Field label="What the legislator wants to say" htmlFor="press-words">
          <Textarea id="press-words" rows={5} value={words} onChange={(e) => setWords(e.target.value)} maxLength={4000} className="text-base" />
        </Field>
      </div>
      <div className="flex items-center gap-4 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending || (!billId && !about.trim())}>{pending ? "Drafting" : "Draft the statement"}</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </form>
  );
}

type EditorProps = { id: string; headline: string; body: string; approved: boolean; canEdit: boolean; canApprove: boolean };

export function StatementEditor({ id, headline: h0, body: b0, approved, canEdit, canApprove }: EditorProps) {
  const router = useRouter();
  const [headline, setHeadline] = useState(h0);
  const [body, setBody] = useState(b0);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = headline !== h0 || body !== b0;
  const unfinished = /\[[^\]]+\]/.test(body);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : (r.error ?? "That did not save."));
      if (r.ok) after?.();
    });
  return (
    <div className="flex max-w-[72ch] flex-col gap-4">
      <Field label="Headline" htmlFor="press-headline">
        <Input id="press-headline" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={200} readOnly={!canEdit} />
      </Field>
      <Textarea aria-label="Statement text" rows={18} value={body} onChange={(e) => setBody(e.target.value)} readOnly={!canEdit} className="text-base" />
      <div className="flex flex-wrap items-center gap-3">
        {canEdit && <Button type="button" disabled={pending || !dirty} onClick={() => run(() => savePressAction(id, { headline, body }))}>Save</Button>}
        {canApprove && !approved && (
          <Button type="button" variant="primary" disabled={pending || dirty || unfinished} onClick={() => run(() => approvePressAction(id))}>Approve</Button>
        )}
        <Button type="button" disabled={dirty} onClick={() => window.print()}>Print</Button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        <button type="button" className={LINK} onClick={async () => {
          await navigator.clipboard.writeText(`${headline}\n\n${body}`);
          setCopied(true);
        }}>
          {copied ? "Copied" : "Copy the statement"}
        </button>
        {canEdit && !confirming && <button type="button" className={LINK} disabled={pending} onClick={() => setConfirming(true)}>Delete</button>}
        {canEdit && confirming && (
          <>
            <button type="button" className={LINK} disabled={pending} onClick={() => run(() => deletePressAction(id), () => router.push("/press"))}>
              Delete it for good
            </button>
            <button type="button" className={LINK} disabled={pending} onClick={() => setConfirming(false)}>Keep it</button>
          </>
        )}
      </div>
      {canApprove && !approved && unfinished && <p className="text-sm text-ink-2">Replace every part in [brackets] before approving.</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
