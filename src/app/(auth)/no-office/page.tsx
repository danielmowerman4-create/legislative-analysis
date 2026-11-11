import type { Metadata } from "next";
import { Button } from "@/components/ui";
import { logoutAction } from "../actions";

export const metadata: Metadata = { title: "No office" };

export default function NoOfficePage() {
  return (
    <>
      <h1 className="mb-1 text-lg font-semibold">No office access</h1>
      <p className="mb-4 text-sm text-ink-2">Your account is not an active member of any legislative office. Ask your office administrator to add you.</p>
      <form action={logoutAction}><Button type="submit">Sign out</Button></form>
    </>
  );
}
