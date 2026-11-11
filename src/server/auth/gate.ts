import type { LoadedSession } from "./sessions";

type Gate = "open" | "signed_out" | "two_step_required" | "password_required";

export function officeGate(s: LoadedSession | null): Gate {
  if (!s?.ctx || !s.mfaVerified) return "signed_out";
  if (s.passwordChangeRequired) return "password_required";
  if (s.mfaRequiredByOffice) return "two_step_required";
  return "open";
}
