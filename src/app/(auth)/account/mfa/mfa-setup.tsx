"use client";

import { useActionState, useState, useTransition } from "react";
import { Button, Field, Input } from "@/components/ui";
import { confirmMfaEnrollmentAction, startMfaEnrollmentAction, type FormState } from "../../actions";

export function MfaSetup({ next }: { next?: string }) {
  const [setup, setSetup] = useState<{ secret: string; url: string } | null>(null);
  const [pending, start] = useTransition();
  const [startError, setStartError] = useState<string>();
  const [state, action, confirming] = useActionState<FormState, FormData>(confirmMfaEnrollmentAction, {});
  const begin = () => start(async () => {
      const r = await startMfaEnrollmentAction();
      setStartError(r.error);
      if (r.data) setSetup({ secret: r.data.secret, url: r.data.url });
    });
  if (!setup) {
    return (
      <>
        <Button variant="primary" disabled={pending} onClick={begin}>Set up</Button>
        {startError && <p role="alert" className="mt-3 text-sm text-danger">{startError}</p>}
      </>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div className="text-sm">
        <p className="text-ink-2">Setup key (enter it manually, or open the link on a device with an authenticator app):</p>
        <p className="mt-1 tabular tracking-wider break-all select-all">{setup.secret.match(/.{1,4}/g)?.join(" ")}</p>
        <a href={setup.url} className="mt-1 inline-block font-semibold text-ink underline decoration-line-strong underline-offset-2">
          Open in authenticator app
        </a>
      </div>
      <Field label="6-digit code" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="tabular tracking-widest" />
      </Field>
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      <Button type="submit" variant="primary" disabled={confirming}>Turn on two-step verification</Button>
    </form>
  );
}
