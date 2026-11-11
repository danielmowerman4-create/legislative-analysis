import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { AppError } from "@/server/errors";
import { sentences } from "@/server/classification/preprocess";
import { STAFF_CATEGORIES, staffCategoryOf } from "@/server/classification/categories";
import { listAgencies } from "@/server/services/cases";
import { getMessageDetail, listIssueOptions } from "@/server/services/inbox";
import { extractBillMentions } from "@/server/classification/bills";
import { listTeam } from "@/server/services/offices";
import { replyRoutes } from "@/server/services/replies";
import { BackLink, DistrictWord, Letter, mailHref, Marked, NoRows, ROOT, TrustWord } from "@/components/center/parts";
import { DraftReplyButton, Handling, NoteForm, OpenCase, ReplyEditor, SenderButtons } from "@/components/center/controls";
import { DoneStamp } from "@/components/center/live";
import { BillTags, IssueTags } from "@/components/center/tags";
import { Status } from "@/components/ui";
import { dateOnly, fullDate, relative, shortDate } from "@/lib/format";

const POSITION_WORD: Record<string, string> = { support: "Supports", oppose: "Opposes", mixed: "Mixed on", neutral: "Asks about", unclear: "Mentions" };
const SANDBOX_HEAD = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`;

function Slip({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-5 first:pt-0">
      <h2 className="display text-[24px] text-ink">{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

async function load(ctx: Parameters<typeof getMessageDetail>[0], id: string) {
  try {
    return await getMessageDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "forbidden") return "restricted" as const;
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
}

export default async function MessagePage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireCenter();
  const { id } = await params;
  const d = await load(ctx, id);
  if (d === "restricted") {
    return (
      <div className="pt-10">
        <h1 className="display max-w-[24ch] text-[36px] text-ink">Restricted to staff who handle sensitive casework</h1>
        <div className="mt-5"><BackLink href={`${ROOT}/mail`}>All mail</BackLink></div>
      </div>
    );
  }

  const m = d.message;
  const held = m.senderTrust === "failed" || m.senderTrust === "unverified";
  // Only a confirmed advocacy platform can name someone else as the writer.
  const relay = m.senderTrust === "relay";
  const writerName = relay ? (m.claimedName ?? m.fromName) : m.fromName;
  const writerAddress = relay ? (m.claimedAddress ?? m.fromAddress) : m.fromAddress;
  const team = (await listTeam(ctx)).filter((t) => t.status === "active").map((t) => ({ userId: t.userId, name: t.name }));
  const canCases = can(ctx, "cases.write");
  const canTag = can(ctx, "inbox.triage");
  const issueOptions = canTag ? await listIssueOptions(ctx) : [];
  const issueTags = d.issues.filter((i) => i.status !== "rejected")
    .map((i) => ({ key: i.key, label: i.label ?? i.key, needsReview: i.status === "needs_review" }));
  const billTags = d.billLinks
    .filter((b) => b.status !== "rejected")
    .map((b) => {
      const p = d.positions.find((x) => x.billReference === b.reference);
      const typed = extractBillMentions(b.rawReference, "")[0]?.reference;
      return {
        reference: b.reference,
        billId: b.billId,
        title: b.bill?.title ?? null,
        stance: p ? POSITION_WORD[p.position] : "",
        position: p?.position ?? ("unclear" as const),
        wrote: typed && typed !== b.reference ? b.rawReference : null,
        candidates: b.candidates.map((c) => ({ id: c.id, identifier: c.identifier, title: c.title })),
      };
    });
  const agencies = canCases ? (await listAgencies(ctx)).map((a) => ({ id: a.id, name: a.name })) : [];
  const openAsks = d.asks.filter((a) => a.status === "open");
  const closedAsks = d.asks.filter((a) => a.status !== "open");
  const draft = d.drafts.find((x) => x.status === "draft" || x.status === "approved" || x.status === "sending");
  const route = draft && can(ctx, "communications.draft") ? (await replyRoutes(ctx, [draft])).get(draft.id) : undefined;
  // Events come newest first.
  const answered = d.events.find((e) => e.type === "reply_sent");
  // A reply sent from here shows until its copy from the Sent folder is read in.
  const repliesInMail = d.thread.filter((t) => t.direction === "outbound");
  const conversation = [
    ...d.thread.map((t) => ({ id: t.id, who: t.direction === "outbound" ? "The office replied" : (t.fromName ?? t.fromAddress), at: t.sentAt,
      text: t.substantiveText, restricted: t.restricted, href: t.direction === "inbound" && !t.restricted ? mailHref(t.id) : null })),
    ...d.drafts
      .filter((x) => x.status === "sent" && x.sentAt && !repliesInMail.some((t) => Math.abs(t.sentAt.getTime() - x.sentAt!.getTime()) < 15 * 60_000))
      .map((x) => ({ id: x.id, who: "The office replied", at: x.sentAt!, text: x.bodyText, restricted: false, href: null })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const noteSpans = sentences(m.personalNote ?? "").flatMap((s) => {
    const start = m.substantiveText.indexOf(s.text);
    return start < 0 ? [] : [{ start, end: start + s.text.length }];
  });
  const spans = [...noteSpans, ...d.asks.map((a) => ({ start: a.quoteStart, end: a.quoteEnd }))];

  return (
    <article className="pt-6">
      <BackLink href={`${ROOT}/mail`}>All mail</BackLink>
      <h1 className="display mt-5 max-w-[30ch] text-[34px] text-ink lg:text-[42px]">{m.subject || "No subject"}</h1>
      <dl className="mt-4 grid grid-cols-[84px_minmax(0,1fr)] gap-x-5 gap-y-1 text-base text-ink-2">
        <dt className="kicker pt-0.5 text-ink-3">From</dt>
        <dd className="min-w-0 break-words">
          <span className="font-semibold text-ink">{writerName ?? writerAddress}</span>
          {writerName ? ` ${writerAddress}` : ""}
        </dd>
        <dt className="kicker pt-0.5 text-ink-3">Received</dt>
        <dd>{fullDate(m.receivedAt)}</dd>
        <dt className="kicker pt-0.5 text-ink-3">Kind</dt>
        <dd>{STAFF_CATEGORIES[staffCategoryOf(m.messageTypes, m.isInternal)]}</dd>
        <dt className="kicker pt-0.5 text-ink-3">Sender</dt>
        <dd className="min-w-0">
          <TrustWord trust={m.senderTrust} />
          {/* TrustWord already says what the mail server found. */}
          {m.senderTrustDetail.reasons
            .filter((r) => !r.startsWith("The mail server"))
            .map((r) => (
              <span key={r} className="block text-sm">{r}</span>
            ))}
          {m.senderTrust === "relay" && <span className="block text-sm">Sent by {m.fromAddress}</span>}
        </dd>
      </dl>

      <div className="mt-8 grid gap-x-10 gap-y-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {held && can(ctx, "senders.manage") && (
            <div className="mb-8 border-y border-line py-4">
              <p className="text-base font-semibold text-ink">Held until someone confirms the sender.</p>
              <SenderButtons messageId={m.id} className="mt-2" />
            </div>
          )}

          {d.formLetter && (
            <p className="mb-6 text-base text-ink-2">
              Form letter sent by {d.formLetter.people} people.{" "}
              <Link href={`${ROOT}/form-letters/${d.formLetter.id}`}
                className="text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                See the campaign
              </Link>
            </p>
          )}

          {m.substantiveText ? (
            <div className="sheet max-w-[46rem]">
              <div className="sheet-stamps">
                <span aria-hidden className="stamp stamp-date text-pen"><b>Received</b>{dateOnly(m.receivedAt)}</span>
                <DoneStamp done={m.triageStatus === "done"} />
              </div>
              <Letter text={m.substantiveText} spans={spans} />
            </div>
          ) : (
            <div className="max-w-[68ch]"><NoRows>This message has no text of its own.</NoRows></div>
          )}

          {(m.forwardedText || m.quotedText) && (
            <details className="mt-6 max-w-[68ch] text-base text-ink-2">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Quoted or forwarded text</summary>
              <div className="letter mt-3">{m.forwardedText ?? m.quotedText}</div>
            </details>
          )}
          {m.bodyHtmlSanitized && (
            <details className="mt-4 max-w-[68ch]">
              <summary className="cursor-pointer text-sm font-semibold text-ink">Show the original formatting</summary>
              {/* Sanitized on the way in; the sandbox and CSP let it run nothing and load nothing. */}
              <iframe title="Original message" sandbox="" className="mt-3 h-[480px] w-full border border-line bg-white"
                srcDoc={`${SANDBOX_HEAD}${m.bodyHtmlSanitized}`} />
            </details>
          )}

          {d.attachments.length > 0 && (
            <div className="mt-8 max-w-[68ch]">
              <h2 className="display text-[24px] text-ink">Attachments</h2>
              <ul className="mt-2 text-base text-ink">
                {d.attachments.map((a) => (
                  <li key={a.id}>{a.filename} <span className="text-sm text-ink-2">{a.blockReason}</span></li>
                ))}
              </ul>
            </div>
          )}

          {conversation.length > 0 && (
            <section className="mt-10 max-w-[46rem]">
              <h2 className="display text-[24px] text-ink">In this conversation</h2>
              <ol className="mt-3 border-t border-line">
                {conversation.map((t) => (
                  <li key={t.id} className="border-b border-line py-4">
                    <p className="text-base text-ink-2"><span className="font-semibold text-ink">{t.who}</span> {fullDate(t.at)}</p>
                    {t.restricted ? (
                      <p className="mt-2 text-base text-ink-2">Your role cannot open this message.</p>
                    ) : (
                      <p className="letter mt-2 whitespace-pre-line text-base text-ink">{t.text || "No text of its own."}</p>
                    )}
                    {t.href && (
                      <Link href={t.href}
                        className="mt-2 inline-block text-base text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                        Open this message
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {can(ctx, "communications.draft") && m.direction === "inbound" && (
            <section className="mt-12 max-w-[68ch]">
              <h2 className="rail-title text-[40px] text-ink">Reply</h2>
              {answered && (
                <p className="mt-2 text-base text-ink">
                  Answered {fullDate(answered.createdAt)}
                  {answered.data.via === "mailbox" ? ", from the mailbox" : answered.data.via === "app" ? ", sent from here" : ""}.
                </p>
              )}
              <div className="mt-3">
                {draft ? (
                  <ReplyEditor draft={draft} canApprove={can(ctx, "communications.approve")} route={route} />
                ) : held ? (
                  <p className="text-base text-ink-2">Confirm who sent this before drafting a reply.</p>
                ) : (
                  <DraftReplyButton messageId={m.id} />
                )}
              </div>
            </section>
          )}
        </div>

        <aside aria-label="Routing slip" className="slip min-w-0 self-start">
          <Slip title="What they need">
            {openAsks.length === 0 && <p className="text-base text-ink-2">Nothing open.</p>}
            <ul className="flex flex-col gap-4">
              {openAsks.map((a) => (
                <li key={a.id}>
                  <p className="text-base font-semibold text-ink">{a.summary}</p>
                  {a.urgency !== "routine" && (
                    <Status tone={a.urgency === "urgent" ? "danger" : "warn"}>
                      {a.dueAt ? `Due ${shortDate(a.dueAt)}` : a.urgency === "urgent" ? "Urgent" : "Soon"}
                    </Status>
                  )}
                  <p className="mt-1 text-sm text-ink-2"><Marked>{a.quote}</Marked></p>
                  {canCases && !held && ["casework", "deadline", "safety"].includes(a.kind) && (
                    <OpenCase askId={a.id} defaultTitle={m.subject || a.summary}
                      defaultCategory={a.summary.replace(/^Asks for help:?\s*/, "") || "General assistance"} team={team} agencies={agencies} />
                  )}
                </li>
              ))}
            </ul>
            {closedAsks.length > 0 && <p className="mt-3 text-sm text-ink-2">{closedAsks.length} already handled</p>}
          </Slip>

          {can(ctx, "inbox.triage") && (
            <Slip title="Handling"><Handling messageId={m.id} assignedTo={m.assignedTo} status={m.triageStatus} team={team} /></Slip>
          )}

          <Slip title="Bills"><BillTags messageId={m.id} tags={billTags} canEdit={canTag} /></Slip>

          <Slip title="Issues"><IssueTags messageId={m.id} tags={issueTags} options={issueOptions} canEdit={canTag} /></Slip>

          {d.contact && can(ctx, "contacts.read") && (
            <Slip title="Person">
              <Link href={`${ROOT}/people/${d.contact.id}`}
                className="text-base font-semibold text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                {d.contact.fullName ?? m.fromAddress}
              </Link>
              <p className="text-sm"><DistrictWord status={d.contact.districtStatus} /></p>
              {d.previous.length > 0 && <p className="text-sm text-ink-2">{d.previous.length} earlier messages</p>}
            </Slip>
          )}

          {d.cases.length > 0 && (
            <Slip title="Cases">
              <ul className="text-base">
                {d.cases.map((c) => (
                  <li key={c.id}>
                    <Link href={`${ROOT}/casework/${c.id}`}
                      className="font-semibold text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">
                      {c.caseNumber}
                    </Link>{" "}
                    <span className="text-sm text-ink-2">{c.title}</span>
                  </li>
                ))}
              </ul>
            </Slip>
          )}

          <Slip title="Notes">
            <ul className="mb-3 flex flex-col gap-3">
              {d.notes.map((n) => (
                <li key={n.id}>
                  <p className="hand note-tilt">{n.body}</p>
                  <p className="text-sm text-ink-3">{n.author ?? "Staff"}, {relative(n.createdAt)}</p>
                </li>
              ))}
            </ul>
            {can(ctx, "inbox.triage") && <NoteForm messageId={m.id} />}
          </Slip>
        </aside>
      </div>
    </article>
  );
}
