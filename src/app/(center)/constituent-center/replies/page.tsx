import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { listDrafts, listSentReplies, replyRoutes } from "@/server/services/replies";
import { mailHref, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { ReplyEditor } from "@/components/center/controls";
import { ActionLink, Status } from "@/components/ui";
import { Tabs } from "@/components/ui/blocks";
import { relative, shortDate } from "@/lib/format";

export default async function RepliesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "communications.draft")) notFound();
  const { view } = await searchParams;
  const sentView = view === "sent";
  const [drafts, sent] = await Promise.all([listDrafts(ctx), listSentReplies(ctx)]);
  const routes = await replyRoutes(ctx, drafts);
  return (
    <>
      <PageTitle title="Replies" />
      <Tabs name="replies" className="mt-4 border-b border-line" current={sentView ? "sent" : "open"} items={[
        { key: "open", label: "In progress", href: `${ROOT}/replies`, count: drafts.length },
        { key: "sent", label: "Sent", href: `${ROOT}/replies?view=sent`, count: sent.length },
      ]} />

      {!sentView && (
        <>
          {drafts.length === 0 && <NoRows>No replies in progress.</NoRows>}
          <ul className="mt-2">
            {drafts.map((d) => (
              <li key={d.id} className="border-b border-line py-7">
                <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
                  <h2 className="display text-[26px] text-ink">{d.subject}</h2>
                  <p className="text-sm text-ink-2">
                    <Status tone={d.status === "draft" ? "neutral" : "ok"}>
                      {d.status === "approved" ? "Approved" : d.status === "sending" ? "Going out" : "Draft"}
                    </Status>{" "}
                    {d.author ?? "Staff"}, {relative(d.updatedAt)}
                  </p>
                </div>
                {d.messageId && (
                  <ActionLink href={mailHref(d.messageId)} className="mt-2">See what they wrote</ActionLink>
                )}
                <div className="mt-4 max-w-[68ch]"><ReplyEditor draft={d} canApprove={can(ctx, "communications.approve")} route={routes.get(d.id)} /></div>
              </li>
            ))}
          </ul>
        </>
      )}

      {sentView && (
        <>
          {sent.length === 0 && <NoRows>No replies sent yet.</NoRows>}
          <ul className="mt-2">
            {sent.map((r) => (
              <li key={r.id} className="border-b border-line py-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
                  <h2 className="display text-[26px] text-ink">{r.subject}</h2>
                  <p className="text-sm text-ink-2">{shortDate(r.sentAt)}</p>
                </div>
                <p className="mt-1 text-base text-ink">To {r.toAddresses.join(", ")}</p>
                <p className="text-sm text-ink-2">
                  {r.approvedByName ? `Approved by ${r.approvedByName}. ` : ""}
                  {r.sentVia === "app" ? `Sent from here by ${r.sentByName ?? "staff"}.` : r.sentVia === "mailbox" ? "Sent from the mailbox."
                    : `Sent by ${r.sentByName ?? "staff"}.`}
                </p>
                <details className="mt-3 max-w-[68ch]">
                  <summary className="cursor-pointer text-sm font-semibold text-ink">Read the reply</summary>
                  <div className="letter mt-3 text-ink">{r.bodyText}</div>
                </details>
                {r.messageId && (
                  <ActionLink href={mailHref(r.messageId)} className="mt-3">See what they wrote</ActionLink>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
