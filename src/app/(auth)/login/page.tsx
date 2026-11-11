import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/next";
import { returnTo } from "@/lib/return-to";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const s = await getSession();
  const next = returnTo((await searchParams).next);
  if (s?.mfaVerified && s.ctx) redirect(next ?? "/today");
  return (
    <>
      <h1 className="anchor text-[72px] text-ink">Sign in</h1>
      <p className="mt-4 mb-8 text-sm text-ink-2">
        Use the account your office administrator created for you. If you are locked out, they can reset your password or two-step verification from Team.
      </p>
      <LoginForm next={next} />
    </>
  );
}
