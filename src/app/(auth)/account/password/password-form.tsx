"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { requiredPasswordAction, type FormState } from "../../actions";

export function PasswordForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requiredPasswordAction, {});
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="The password you were given" htmlFor="current">
        <Input id="current" name="current" type="password" autoComplete="current-password" required autoFocus />
      </Field>
      <Field label="New password" htmlFor="new" hint="At least 12 characters">
        <Input id="new" name="new" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Field label="New password again" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      {state.error && (
        <p role="alert" className="text-sm text-danger">{state.error}</p>
      )}
      <Button type="submit" variant="primary" disabled={pending} className="mt-2 h-11 w-full">{pending ? "Saving…" : "Save password"}</Button>
    </form>
  );
}
