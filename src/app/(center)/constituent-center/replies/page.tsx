import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { listDrafts, listSentReplies, replyRoutes } from "@/server/services/replies";
import { billsToAnswer } from "@/server/services/bill-answers";
import { SplitBar } from "@/components/center/graphs";
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
  const [drafts, sent, waiting] = await Promise.all([listDrafts(ctx), listSentReplies(ctx), billsToAnswer(ctx)]);
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
          {waiting.length > 0 && (
            <section aria-labelledby="bills-to-answer" className="mt-8">
              <h2 id="bills-to-answer" className="rail-title text-[40px] text-ink lg:text-[48px]">Bills to answer</h2>
              <ul className="mt-2">
                {waiting.map((b) => (
                  <li key={b.reference} className="grid items-center gap-x-10 gap-y-1 border-b border-line py-4 md:grid-cols-[190px_minmax(0,1fr)_190px]">
                    <Link href={`${ROOT}/topics/${encodeURIComponent(b.reference)}`}
                      className="text-lg font-semibold text-ink transition-colors hover:text-ink-2">
                      {b.reference}
                    </Link>
                    <div className="min-w-0">
                      {b.title && <p className="line-clamp-1 text-base text-ink">{b.title}</p>}
                      {b.moved && b.lastActionText && <p className="line-clamp-1 text-sm text-ink-2">{b.lastActionText}, {shortDate(b.lastActionAt)}</p>}
                      <SplitBar sides={b} label={b.reference} className="mt-2 max-w-[22rem]" />
                    </div>
                    <p className="tabular text-base text-ink md:text-right">{b.toAnswer} to answer</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {waiting.length > 0 && drafts.length > 0 && <h2 className="rail-title mt-12 text-[40px] text-ink lg:text-[48px]">Drafts</h2>}
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
