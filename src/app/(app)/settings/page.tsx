import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { can } from "@/server/authz/context";
import { getOfficeSettings, listAudit } from "@/server/services/settings";
import { legislativeFreshness } from "@/server/services/legislation";
import { ActionLink, PageHeader, Table, Td, Th } from "@/components/ui";
import { Freshness, KeyValue, Section } from "@/components/ui/blocks";
import { fullDate } from "@/lib/format";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/password";
import { PasswordSettings, ProfileSettings, SecuritySettings, SyncNowButton } from "./settings-forms";

export const metadata: Metadata = { title: "Settings" };

type Row = [string, React.ReactNode];

export default async function SettingsPage() {
  const { ctx, user } = await requireOffice();
  const [{ org, settings, configured }, fresh] = await Promise.all([getOfficeSettings(ctx), legislativeFreshness(ctx)]);
  const canManage = can(ctx, "settings.manage");
  const auditRows = can(ctx, "audit.read") ? await listAudit(ctx, 40) : [];
  const feed = configured.legiscan ? "LegiScan" : configured.openstates ? "Open States" : null;
  const source = org.jurisdictionCode === "ZZ" ? "Demo data (fictional)" : org.jurisdictionCode === "CT" ? "Connecticut General Assembly public files" : feed;

  return (
    <>
      <PageHeader title="Settings" meta="Office" />
      <div className="wrap">
        <div>
          <Section title="Office">
            <ProfileSettings canEdit={canManage} profile={{
              name: org.name,
              legislatorName: org.legislatorName ?? "",
              district: org.district ?? "",
              jurisdiction: org.jurisdictionCode,
              chamber: org.chamber,
            }} />
          </Section>
          {can(ctx, "inbox.read") && (
            <Section title="Constituent Center">
              <div className="flex flex-col items-start gap-2">
                <ActionLink href="/constituent-center/setup#link">Link your Outlook or Gmail</ActionLink>
                <ActionLink href="/constituent-center/setup/reading">Change how mail is read</ActionLink>
              </div>
            </Section>
          )}
          <Section title="Legislative data">
            <KeyValue items={[["Source", source ?? <span className="text-warn">Not set up. An administrator adds a LegiScan API key to the deployment.</span>],
              ["Last check", <Freshness key="f" at={fresh.lastOk?.finishedAt} stale={fresh.stale} label="Checked" snapshotAt={fresh.snapshotAt} />],
              ...(fresh.snapshotAt ? [] : ([["Bills changed", fresh.lastOk ? `${fresh.lastOk.billsChanged} in the last check` : "None yet"]] as Row[])),
              ...(fresh.lastFailed ? ([["Last error", <span key="e" className="text-danger">{fresh.lastFailed.error ?? "Failed"}</span>]] as Row[]) : [])]} />
            {can(ctx, "integrations.manage") && source && !fresh.snapshotAt && (
              <div className="mt-4"><SyncNowButton /></div>
            )}
          </Section>
          <Section title="Your password"><PasswordSettings email={user.email} minLength={PASSWORD_MIN_LENGTH} /></Section>
          <Section title="Sign-in">
            <SecuritySettings canEdit={canManage} requireMfa={settings.requireMfa} />
            <p className="mt-3 text-sm text-ink-2">
              Your own two-step verification:{" "}
              <Link href="/account/mfa" className="font-semibold text-ink underline decoration-rule underline-offset-4 hover:text-ink-2">set up or change</Link>
              .
            </p>
          </Section>
          {auditRows.length > 0 && (
            <Section title="Audit log">
              <div className="overflow-x-auto">
                <Table className="min-w-[640px]">
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Who</Th>
                      <Th>Action</Th>
                      <Th>Record</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((a) => (
                      <tr key={a.id}>
                        <Td className="tabular text-ink-2">{fullDate(a.createdAt)}</Td>
                        <Td>{a.actor ?? "System"}</Td>
                        <Td>{a.action.replace(/[._]/g, " ")}</Td>
                        <Td className="text-ink-3">{auditRecord(a.summary, a.entityType)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function auditRecord(summary: unknown, entityType: string) {
  const s = (summary ?? {}) as { identifier?: string; with?: string[] };
  return s.identifier ?? (s.with?.length ? s.with.join(" and ") : entityType);
}
