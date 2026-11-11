import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/next";
import { logoutAction } from "../../actions";
import { MfaSetup } from "./mfa-setup";

export const metadata: Metadata = { title: "Two-step verification" };

type AccountMfaPageProps = { searchParams: Promise<{ required?: string; next?: string }> };

export default async function AccountMfaPage({ searchParams }: AccountMfaPageProps) {
  const s = await getSession();
  if (!s || !s.mfaVerified) redirect("/login");
  if (s.passwordChangeRequired) redirect("/account/password");
  const { required, next } = await searchParams;
  return (
    <>
      <h1 className="anchor text-[72px] text-ink">Two-step verification</h1>
      {s.user.mfaEnabled ? (
        <p className="text-sm text-ink-2">
          Two-step verification is on for {s.user.email}.{" "}
          <Link href="/today" className="font-semibold text-ink underline decoration-line-strong underline-offset-2">Back to the app</Link>
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink-2">
            {required ? "Your office requires two-step verification. " : ""}
            Add this account to an authenticator app, then enter the 6-digit code it shows.
          </p>
          <MfaSetup next={next} />
        </>
      )}
      <form action={logoutAction} className="mt-8">
        <button type="submit" className="text-sm text-ink-2 underline underline-offset-4 decoration-line-strong hover:text-ink">Sign out</button>
      </form>
    </>
  );
}
