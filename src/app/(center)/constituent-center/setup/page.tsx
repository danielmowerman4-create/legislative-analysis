import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { listSenderRules, setupStatus } from "@/server/services/center";
import Link from "next/link";
import { linkErrorMessage, listMailboxFolders } from "@/server/email/connections";
import { listTeam } from "@/server/services/offices";
import { getEnv } from "@/server/env";
import { Block, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import {
  AddressLookupSwitch,
  AiGuidanceForm,
  AiSwitch,
  CheckMailButton,
  ConnectMailbox,
  DisconnectButton,
  DomainsForm,
  FolderForm,
  FormLetterSettings,
  MailboxSending,
  RuleButton,
  RuleForm,
  SignatureForm,
} from "@/components/center/controls";
import { ActionLink, Notice, Status, Table, Td, Th } from "@/components/ui";
import { isoDaysAgo, relative, shortDate } from "@/lib/format";
import { lastErrorText, problemLines } from "@/lib/mailbox-problems";

const STATUS_WORD: Record<string, string> = { pending: "Not reading yet", active: "Reading", reauth_required: "Needs signing in again", error: "Stopped",
  disconnected: "Disconnected" };
const PROVIDER: Record<string, string> = { microsoft: "Outlook", google: "Gmail", imap: "Email" };
const BY_DOMAIN: [RegExp, string][] = [
  [/^(gmail|googlemail)\.com$/, "Gmail"],
  [/^(yahoo|ymail|rocketmail)\.com$/, "Yahoo"],
  [/^(icloud|me|mac)\.com$/, "iCloud"],
  [/^aol\.com$/, "AOL"],
];
const serviceOf = (m: { provider: string; emailAddress: string }) => m.provider === "imap"
  ? (BY_DOMAIN.find(([re]) => re.test(m.emailAddress.split("@")[1] ?? ""))?.[1] ?? PROVIDER.imap) : PROVIDER[m.provider];
const TEXT_LINK = "text-sm font-semibold text-ink underline underline-offset-4 decoration-line-strong transition-colors hover:decoration-ink";
const READS_MAIL = new Set(["owner", "chief_of_staff", "legislative_aide", "caseworker"]);
const RULE_KIND: Record<string, string> = { hide: "Set aside", relay: "Sends for people" };
const RULE_STATUS: Record<string, string> = { active: "On", proposed: "Suggested, not on", retired: "Off" };

type SetupPageProps = { searchParams: Promise<{ mailbox?: string; error?: string; sending?: string }> };

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const { ctx } = await requireCenter();
  const sp = await searchParams;
  const s = await setupStatus(ctx);
  const canSettings = can(ctx, "settings.manage");
  const problems = problemLines(s.errors);
  const rules = can(ctx, "senders.manage") ? await listSenderRules(ctx) : null;
  const linked = s.mailboxes.filter((m) => m.status !== "disconnected");
  const configuring = sp.mailbox ? linked.find((m) => m.id === sp.mailbox && m.canManage) : undefined;
  const folders = configuring ? await listMailboxFolders(ctx, configuring.id).catch(() => null) : null;
  const defaultFrom = isoDaysAgo(30);
  const sendingOn = sp.sending ? linked.find((m) => m.id === sp.sending && m.sendingSince) : undefined;
  const notLinked = can(ctx, "integrations.manage") ? (await listTeam(ctx)).filter(
        (t) => t.status === "active" && READS_MAIL.has(t.roleKey) && t.userId !== ctx.userId && !linked.some((m) => m.authorizedBy === t.userId),
      )
    : [];

  return (
    <>
      <PageTitle title="Settings" />
      {sp.error && (
        <div className="mt-6"><Notice tone="danger" title="The mailbox was not linked">{linkErrorMessage(sp.error)}</Notice></div>
      )}

      {sendingOn && (
        <div className="mt-6"><Notice tone="ok" title="Sending is on">A test message was delivered to {sendingOn.emailAddress}.</Notice></div>
      )}

      <Block title="Email">
        {linked.length === 0 && <NoRows>No email linked yet.</NoRows>}
        {linked.length > 0 && (
          <ul>
            {linked.map((m) => {
              // Mail servers spell the inbox in capitals.
              const names = m.selectedFolders.map((f) => (/^inbox$/i.test(f.name) ? "Inbox" : f.name)).join(", ");
              const reads = names ? `Reads ${names}${m.sentFolder ? ` and watches ${m.sentFolder.name} for replies` : ""}.` : "";
              const synced = m.lastSyncedAt ? `Last read ${relative(m.lastSyncedAt)}.` : "";
              return (
                <li key={m.id} className="border-b border-line py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
                    <p className="min-w-0 break-words text-lg font-semibold text-ink">{m.emailAddress}</p>
                    <Status tone={m.status === "active" ? "ok" : m.status === "pending" ? "neutral" : "warn"}>{STATUS_WORD[m.status]}</Status>
                  </div>
                  <p className="text-sm text-ink-2">{serviceOf(m)}, linked by {m.mine ? "you" : (m.linkedBy ?? "staff")}. {reads} {synced}</p>
                  {m.status === "active" && (
                    <p className="text-sm text-ink-2">
                      {m.sendingSince ? `Sends approved replies when a person presses Send. On since ${shortDate(m.sendingSince)}.`
                        : "Does not send. Approved replies open in your own mail."}
                    </p>
                  )}
                  {m.lastError && <p className="text-sm text-danger">{lastErrorText(m.lastError)}</p>}
                  {m.canManage && (
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
                      <Link href={`${ROOT}/setup?mailbox=${m.id}`} className={TEXT_LINK}>
                        {m.status === "pending" ? "Choose what it reads" : "Change what it reads"}
                      </Link>
                      {m.status === "active" && (
                        <MailboxSending id={m.id} address={m.emailAddress} on={Boolean(m.sendingSince)} needsSignIn={m.sendNeedsSignIn} />
                      )}
                      <DisconnectButton id={m.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {linked.some((m) => m.status === "active") && (
          <div className="mt-3"><CheckMailButton /></div>
        )}
        {configuring && (
          <div className="mt-6 max-w-xl">
            <h3 className="display text-[26px] text-ink">{configuring.emailAddress}</h3>
            {folders ? (
              <div className="mt-3">
                <FolderForm id={configuring.id} folders={folders} defaultFrom={configuring.importFrom ?? defaultFrom} current={ configuring.status === "pending"
                  ? undefined : { folderIds: configuring.selectedFolders.map((f) => f.id), watchSent: Boolean(configuring.sentFolder) } } />
              </div>
            ) : (
              <p className="mt-2 text-sm text-danger">The folders could not be read. Try connecting the mailbox again.</p>
            )}
          </div>
        )}
        {notLinked.length > 0 && (
          <p className="mt-4 text-base text-ink">
            Not linked yet: {notLinked.map((t) => t.name).join(", ")}. Each person links their own email after signing in.
          </p>
        )}
        <div id="link" className="mt-8 max-w-3xl scroll-mt-24">
          <h3 className="display text-[26px] text-ink">Link your email</h3>
          <div className="mt-3">
            <ConnectMailbox microsoft={s.configured.microsoft} google={s.configured.google}
              approvalUrl={s.configured.microsoft ? `${getEnv().APP_URL}/api/integrations/microsoft/approval` : null} />
          </div>
        </div>
      </Block>

      {canSettings && (
        <Block title="Reply signature"><SignatureForm signature={s.settings.replySignature ?? ""} /></Block>
      )}

      {(can(ctx, "taxonomy.manage") || canSettings) && (
        <Block title="How mail is read"><ActionLink href={`${ROOT}/setup/reading`}>Change the issues, agencies and tagging levels</ActionLink></Block>
      )}

      <Block title="AI reading">
        <p className="text-base text-ink">
          {!s.configured.anthropic ? "No AI key on this server. Rules read the mail." : s.settings.aiEnabled && s.settings.aiConsentAt
            ? `On. ${s.aiUsedToday} of ${s.settings.aiDailyLimit} readings used today.` : "Off. Rules read the mail."}
        </p>
        {canSettings && s.configured.anthropic && <div className="mt-3"><AiSwitch enabled={Boolean(s.settings.aiEnabled && s.settings.aiConsentAt)} /></div>}
      </Block>

      {canSettings && s.configured.anthropic && (
        <Block title="Notes for AI"><AiGuidanceForm guidance={s.settings.aiGuidance ?? ""} /></Block>
      )}

      <Block title="District lookup">
        <p className="max-w-3xl text-base text-ink">
          {s.settings.addressLookupEnabled
            ? `On. Street addresses from confirmed senders go to ${s.configured.geocodio ? "Geocodio" : "the U.S. Census Bureau"} to find the district.`
            : "Off. Staff set each person's district."}
        </p>
        {canSettings && <div className="mt-3"><AddressLookupSwitch enabled={s.settings.addressLookupEnabled} /></div>}
      </Block>

      {canSettings && (
        <Block title="Form letters"><FormLetterSettings overlap={s.settings.templateOverlap} minWords={s.settings.templateMinWords} /></Block>
      )}

      <Block title="Office domains">
        {canSettings ? <DomainsForm domains={s.internalDomains} /> : <p className="text-base text-ink">{s.internalDomains.join(", ") || "None set"}</p>}
      </Block>

      {rules && (
        <Block title="Sender rules">
          <RuleForm />
          {rules.length > 0 && (
            <div className="mt-6 overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Sender</Th>
                    <Th>Rule</Th>
                    <Th>State</Th>
                    <Th align="right">Caught</Th>
                    <Th>Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <span className="text-base font-semibold text-ink">{r.value}</span>
                        {r.reason && <p className="text-sm text-ink-2">{r.reason}</p>}
                      </Td>
                      <Td>{RULE_KIND[r.kind]}</Td>
                      <Td>{RULE_STATUS[r.status]}</Td>
                      <Td align="right">{r.hits}</Td>
                      <Td>
                        <RuleButton id={r.id} status={r.status} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Block>
      )}

      {problems.length > 0 && (
        <Block title="Problems">
          <ul className="text-base text-ink">
            {problems.map((e) => (
              <li key={e.id} className="border-b border-line py-3">{e.text} <span className="text-sm text-ink-2">{relative(e.lastSeenAt)}</span></li>
            ))}
          </ul>
        </Block>
      )}
    </>
  );
}
