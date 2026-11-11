import type { requireOffice } from "@/server/auth/next";
import { logoutAction } from "@/app/(auth)/actions";
import { switchOfficeAction } from "@/app/(app)/shell-actions";
import { UserMenu } from "./user-menu";

type Session = Awaited<ReturnType<typeof requireOffice>>;

const CHAMBER_NAME: Record<string, string> = { lower: "House", upper: "Senate" };

export const officeDetail = (org: Session["org"]) => org.district ? `${CHAMBER_NAME[org.chamber] ?? ""} District ${org.district}`.trim()
  : (org.legislatorName ?? "");

export function AccountMenu({ session }: { session: Session }) {
  return (
    <UserMenu name={session.user.name} email={session.user.email} offices={session.offices} activeOrgId={session.org.id} logout={logoutAction}
      switchOffice={switchOfficeAction} />
  );
}
