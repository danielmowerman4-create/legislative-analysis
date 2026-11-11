"use client";

import { useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/ui";
import { changePasswordAction, mfaPolicyAction, profileAction } from "./actions";
import { syncNowAction } from "../bills/actions";

type Message = { ok: boolean; text: string } | null;

function useRun() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Message>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okText = "Saved") =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error ?? "Not saved" });
    });
  return { pending, msg, run };
}
const Msg = ({ msg }: { msg: Message }) => msg ? <span role="status" className={msg.ok ? "text-sm text-ok" : "text-sm text-danger"}>{msg.text}</span> : null;

type ProfileSettingsProps = { canEdit: boolean; profile: { name: string; legislatorName: string; district: string; jurisdiction: string; chamber: string } };

export function ProfileSettings({ canEdit, profile }: ProfileSettingsProps) {
  const { pending, msg, run } = useRun();
  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      run(() => profileAction({ name: String(f.get("name")), legislatorName: String(f.get("legislatorName")), district: String(f.get("district")) }));
    }}>
      <Field label="Office name" htmlFor="name"><Input id="name" name="name" defaultValue={profile.name} disabled={!canEdit} className="h-9" /></Field>
      <Field label="Legislator" htmlFor="legislatorName" hint="Bills with this lead sponsor appear as the office's bills.">
        <Input id="legislatorName" name="legislatorName" defaultValue={profile.legislatorName} disabled={!canEdit} className="h-9" />
      </Field>
      <Field label="District" htmlFor="district">
        <Input id="district" name="district" defaultValue={profile.district} disabled={!canEdit} className="h-9" />
      </Field>
      <Field label="State and chamber" htmlFor="j">
        <Input id="j" value={`${profile.jurisdiction} · ${profile.chamber === "upper" ? "Senate" : "House"}`} disabled className="h-9" />
      </Field>
      {canEdit && (
        <div className="flex items-center gap-3"><Button type="submit" variant="primary" disabled={pending}>Save</Button><Msg msg={msg} /></div>
      )}
    </form>
  );
}

export function PasswordSettings({ email, minLength }: { email: string; minLength: number }) {
  const { pending, msg, run } = useRun();
  return (
    <form className="grid max-w-md gap-3" onSubmit={(e) => {
      e.preventDefault();
      const el = e.currentTarget;
      const f = new FormData(el);
      run(async () => {
        const r = await changePasswordAction({ current: String(f.get("currentPassword")), next: String(f.get("newPassword")),
          confirm: String(f.get("confirmPassword")) });
        if (r.ok) el.reset();
        return r;
      }, "Password changed. Any other devices were signed out.");
    }}>
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field label="Current password" htmlFor="currentPassword">
        <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required className="h-9" />
      </Field>
      <Field label="New password" htmlFor="newPassword" hint={`At least ${minLength} characters.`}>
        <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={minLength} required className="h-9" />
      </Field>
      <Field label="Confirm new password" htmlFor="confirmPassword">
        <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={minLength} required className="h-9" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>Change password</Button>
        <Msg msg={msg} />
      </div>
    </form>
  );
}

export function SecuritySettings({ canEdit, requireMfa }: { canEdit: boolean; requireMfa: boolean }) {
  const { pending, msg, run } = useRun();
  const [on, setOn] = useState(requireMfa);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2.5 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={on} disabled={!canEdit} onChange={(e) => setOn(e.target.checked)} />
        <span>Require two-step verification for everyone in the office</span>
      </label>
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={pending || on === requireMfa} onClick={() => run(() => mfaPolicyAction(on))}>Save</Button>
          <Msg msg={msg} />
        </div>
      )}
    </div>
  );
}

export function SyncNowButton() {
  const { pending, msg, run } = useRun();
  return (
    <span className="flex items-center gap-3">
      <Button disabled={pending} onClick={() => run(syncNowAction, "Update queued. New actions appear within a few minutes.")}>Check for updates now</Button>
      <Msg msg={msg} />
    </span>
  );
}
