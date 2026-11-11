import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/next";
import { returnTo } from "@/lib/return-to";
import { MfaForm } from "./mfa-form";

export const metadata: Metadata = { title: "Verify sign-in" };

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const s = await getSession();
  const next = returnTo((await searchParams).next);
  if (!s) redirect("/login");
  if (s.mfaVerified) redirect(next ?? "/today");
  return (
    <>
      <h1 className="anchor text-[72px] text-ink">Two-step verification</h1>
      <p className="mb-5 text-sm text-ink-2">Enter the 6-digit code from your authenticator app.</p>
      <MfaForm next={next} />
    </>
  );
}
