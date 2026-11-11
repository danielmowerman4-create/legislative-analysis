import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/next";
import { returnTo } from "@/lib/return-to";
import { logoutAction } from "../../actions";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Choose a password" };

export default async function AccountPasswordPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!s.mfaVerified) redirect("/login/mfa");
  const next = returnTo((await searchParams).next);
  if (!s.passwordChangeRequired) redirect(next ?? "/today");
  return (
    <>
      <h1 className="anchor text-[72px] text-ink">Choose a password</h1>
      <p className="mb-5 text-sm text-ink-2">The password you signed in with was set for you. Choose one only you know.</p>
      <PasswordForm next={next} />
      <form action={logoutAction} className="mt-8">
        <button type="submit" className="text-sm text-ink-2 underline underline-offset-4 decoration-line-strong hover:text-ink">Sign out</button>
      </form>
    </>
  );
}
