"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { addMemberAction, memberPasswordAction, memberRoleAction, memberStatusAction, memberTwoStepAction } from "./actions";

type Role = { key: string; name: string };
type Message = { ok: boolean; text: string } | null;

export function MemberControls({ userId, roleKey, status, roles }: { userId: string; roleKey: string; status: string; roles: Role[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
    });
  return (
    <span className="flex items-center gap-2">
      <Select aria-label="Role" className="h-7 w-40" defaultValue={roleKey} disabled={pending}
        onChange={(e) => run(() => memberRoleAction(userId, e.target.value))}>
        {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
      </Select>
      <button type="button" className="text-sm text-ink-3 hover:text-ink" disabled={pending}
        onClick={() => run(() => memberStatusAction(userId, status === "active" ? "disabled" : "active"))}>
        {status === "active" ? "Disable" : "Enable"}
      </button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </span>
  );
}

export function MemberRecovery({ userId, name, twoStepOn }: { userId: string; name: string; twoStepOn: boolean }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const [temporary, setTemporary] = useState("");
  const [msg, setMsg] = useState<Message>(null);
  const link = "text-sm text-ink-2 underline underline-offset-4 decoration-line-strong hover:text-ink disabled:opacity-50";
  return (
    <span className="flex flex-col items-start gap-1.5">
      <button type="button" className={link} disabled={pending} aria-expanded={open} onClick={() => { setOpen((v) => !v); setMsg(null); }}>
        Reset password
      </button>
      {open && (
        <form className="flex items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await memberPasswordAction(userId, temporary);
            const text = `Set. Give it to ${name} yourself; they will be asked to choose their own when they sign in.`;
            setMsg(r.ok ? { ok: true, text } : { ok: false, text: r.error });
            if (r.ok) {
              setTemporary("");
              setOpen(false);
            }
          });
        }}>
          {/* Plain text so the owner can pass it on; kept out of saved passwords. */}
          <Input aria-label={`Temporary password for ${name}`} placeholder="Temporary password" value={temporary} onChange={(e) => setTemporary(e.target.value)}
            minLength={12} required autoComplete="off" spellCheck={false} className="h-8 w-56" />
          <Button type="submit" disabled={pending || temporary.length < 12}>Set</Button>
        </form>
      )}
      {twoStepOn && (
        <button type="button" className={link} disabled={pending} onClick={() => {
          if (!sure) return setSure(true);
          start(async () => {
            const r = await memberTwoStepAction(userId);
            setMsg(r.ok ? { ok: true, text: `Reset. ${name} sets it up again at their next sign-in.` } : { ok: false, text: r.error });
            setSure(false);
          });
        }}>
          {sure ? `Reset two-step for ${name} now` : "Reset two-step"}
        </button>
      )}
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "block w-60 text-sm text-ok" : "block w-60 text-sm text-danger"}>{msg.text}</span>
      )}
    </span>
  );
}

export function AddMemberForm({ roles }: { roles: Role[] }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Message>(null);
  return (
    <form className="grid gap-3 md:grid-cols-5" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      start(async () => {
        const r = await addMemberAction({ name: String(f.get("name")), email: String(f.get("email")), title: String(f.get("title")),
          roleKey: String(f.get("role")), password: String(f.get("password")) });
        const text = "Added. Give them the temporary password yourself. They will be asked to choose their own when they first sign in.";
        setMsg(r.ok ? { ok: true, text } : { ok: false, text: r.error });
        if (r.ok) form.reset();
      });
    }}>
      <Field label="Name" htmlFor="m-name"><Input id="m-name" name="name" required /></Field>
      <Field label="Email" htmlFor="m-email"><Input id="m-email" name="email" type="email" required /></Field>
      <Field label="Title" htmlFor="m-title"><Input id="m-title" name="title" /></Field>
      <Field label="Role" htmlFor="m-role">
        <Select id="m-role" name="role" defaultValue="legislative_aide">
          {roles.map((r) => (
            <option key={r.key} value={r.key}>{r.name}</option>
          ))}
        </Select>
      </Field>
      <Field label="Temporary password" htmlFor="m-pw" hint="At least 12 characters">
        <Input id="m-pw" name="password" type="password" minLength={12} required autoComplete="new-password" />
      </Field>
      <div className="flex items-center gap-3 md:col-span-5">
        <Button type="submit" variant="primary" disabled={pending}>Add staff member</Button>
        {msg && <span className={msg.ok ? "text-sm text-ok" : "text-sm text-danger"}>{msg.text}</span>}
      </div>
    </form>
  );
}
