import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { agenciesForEditing, issueListForEditing, readingSettings } from "@/server/services/reading";
import { BackLink, Block, PageTitle, ROOT } from "@/components/center/parts";
import { AgencyList, AiLimit, IssueList, TaggingLevels } from "@/components/center/reading";

export const metadata = { title: "How mail is read" };

export default async function ReadingPage() {
  const { ctx } = await requireCenter();
  const canIssues = can(ctx, "taxonomy.manage");
  const canOffice = can(ctx, "settings.manage");
  if (!canIssues && !canOffice) notFound();
  const [issues, agencies, settings] = await Promise.all([canIssues ? issueListForEditing(ctx) : [], canOffice ? agenciesForEditing(ctx) : [],
    canOffice ? readingSettings(ctx) : null]);
  return (
    <>
      <div className="pt-6"><BackLink href={`${ROOT}/setup`}>Settings</BackLink></div>
      <PageTitle title="How mail is read" className="pt-3 lg:pt-4" />
      {canIssues && (
        <Block title="Issues">
          <p className="mb-4 max-w-3xl text-base text-ink">Mail that uses an issue&rsquo;s words gets tagged with it. A change applies to new mail at once, and within a few minutes to mail already here unless AI read it. A tag a person set never changes.</p>
          <IssueList issues={issues} />
        </Block>
      )}
      {settings && (
        <Block title="Agencies">
          <p className="mb-4 max-w-3xl text-base text-ink">Used to recognize mail from government and to suggest where a case should go.</p>
          <AgencyList agencies={agencies} />
        </Block>
      )}
      {settings && (
        <Block title="How sure it has to be">
          <p className="mb-4 max-w-3xl text-base text-ink">Below these levels, a tag waits for a person to check it.</p>
          <TaggingLevels levels={settings.thresholds} />
        </Block>
      )}
      {settings && (
        <Block title="AI limit"><AiLimit limit={settings.aiDailyLimit} /></Block>
      )}
    </>
  );
}
