"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { mfaAction, type FormState } from "../../actions";

export function MfaForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(mfaAction, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Verification code" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
          className="tabular tracking-widest" />
      </Field>
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      <Button type="submit" variant="primary" disabled={pending}>{pending ? "Verifying…" : "Verify"}</Button>
    </form>
  );
}
