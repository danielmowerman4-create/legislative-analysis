"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { loginAction, type FormState } from "../actions";

export function LoginForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="username" required autoFocus /></Field>
      <Field label="Password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
      {state.error && <p role="alert" className="text-sm text-danger">{state.error}</p>}
      <Button type="submit" variant="primary" disabled={pending} className="mt-2 h-11 w-full">{pending ? "Signing in…" : "Sign in"}</Button>
    </form>
  );
}
