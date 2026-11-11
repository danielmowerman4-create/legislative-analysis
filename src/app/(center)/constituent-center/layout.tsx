import type { Metadata } from "next";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { centerCounts, hasMailbox } from "@/server/services/center";
import { CenterShell } from "@/components/center/shell";
import { AccountMenu, officeDetail } from "@/components/shell/account";

export const metadata: Metadata = { title: "Constituent Center" };

export default async function CenterLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCenter();
  const { ctx, org } = session;
  const [counts, connected] = await Promise.all([centerCounts(ctx), hasMailbox(ctx.orgId)]);
  return (
    <CenterShell
      counts={counts}
      access={{
        cases: can(ctx, "cases.read"),
        contacts: can(ctx, "contacts.read"),
        replies: can(ctx, "communications.draft"),
        ledger: can(ctx, "ledger.read"),
      }}
      office={{ name: org.name, detail: officeDetail(org) }}
      demo={org.isDemo && !connected}
      user={<AccountMenu session={session} />}
    >
      {children}
    </CenterShell>
  );
}
