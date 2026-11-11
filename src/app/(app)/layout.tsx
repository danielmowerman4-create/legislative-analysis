import { asc, desc, eq } from "drizzle-orm";
import { requireOffice } from "@/server/auth/next";
import { shellCounts } from "@/server/services/shell";
import { centerEnabled } from "@/server/services/center";
import { can } from "@/server/authz/context";
import { systemDb } from "@/server/db/client";
import { legislativeSessions } from "@/server/db/schema";
import { Footer, Masthead } from "@/components/shell/masthead";
import { CommandPalette } from "@/components/shell/command-palette";
import { PageTransition } from "@/components/motion";
import { AccountMenu, officeDetail } from "@/components/shell/account";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireOffice();
  const counts = await shellCounts(session.ctx);
  const center = can(session.ctx, "inbox.read") && (await centerEnabled(session.org.id));
  const org = session.org;
  // Sessions are public data, so they are read outside the office's scope.
  const [current] = await (await systemDb())
    .select({ identifier: legislativeSessions.identifier })
    .from(legislativeSessions)
    .where(eq(legislativeSessions.jurisdictionCode, org.jurisdictionCode))
    .orderBy(asc(legislativeSessions.isSpecial), desc(legislativeSessions.startDate))
    .limit(1);

  return (
    <div className="flex min-h-screen flex-col">
      <Masthead
        counts={counts}
        office={{ name: org.name, detail: officeDetail(org) }}
        session={current ? `${current.identifier.replace("-", "–")} session` : null}
        demo={org.isDemo}
        center={center}
        user={<AccountMenu session={session} />}
      />
      <main id="main" className="flex min-w-0 flex-1 flex-col"><PageTransition>{children}</PageTransition></main>
      <Footer />
      <CommandPalette />
    </div>
  );
}
