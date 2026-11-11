import Link from "next/link";
import { Download } from "lucide-react";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { STAFF_CATEGORIES, staffCategoryOf, type StaffCategory } from "@/server/classification/categories";
import { listTeam } from "@/server/services/offices";
import { folderCounts, INBOX_FOLDERS, listInbox, type InboxFolder } from "@/server/services/inbox";
import { BulkCheck, BulkMail } from "@/components/center/controls";
import { DISTRICT_VIEWS, DistrictWord, mailHref, NoRows, PageTitle, ROOT, trustInfo } from "@/components/center/parts";
import { ActionLink, Button, cn, Input, Status } from "@/components/ui";
import { Segmented, Tabs } from "@/components/ui/blocks";
import { fullDate, shortDate } from "@/lib/format";

const SHOWN: InboxFolder[] = ["all", "new", "urgent", "held", "mine", "service", "policy", "meeting", "agency", "automated", "done"];
const PAGE = 50;

type MailPageProps = { searchParams: Promise<{ folder?: string; kind?: string; district?: string; q?: string; issue?: string; page?: string }> };

export default async function MailPage({ searchParams }: MailPageProps) {
  const { ctx } = await requireCenter();
  const sp = await searchParams;
  const folder = (SHOWN as string[]).includes(sp.folder ?? "") ? (sp.folder as InboxFolder) : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const q = sp.q?.trim() || undefined;
  const issue = sp.issue?.trim() || undefined;
  const kind = sp.kind && Object.hasOwn(STAFF_CATEGORIES, sp.kind) ? (sp.kind as StaffCategory) : undefined;
  const district = sp.district && Object.hasOwn(DISTRICT_VIEWS, sp.district) ? (sp.district as keyof typeof DISTRICT_VIEWS) : undefined;
  const canTriage = can(ctx, "inbox.triage");
  const [list, counts, team] = await Promise.all([listInbox(ctx, { folder, kind, district, q, issue, limit: PAGE, offset: (page - 1) * PAGE }),
    folderCounts(ctx), canTriage ? listTeam(ctx) : []]);
  const href = (patch: { folder?: string; page?: number; kind?: string | null; district?: string | null }) => {
    const p = new URLSearchParams();
    const f = patch.folder ?? folder;
    if (f !== "all") p.set("folder", f);
    const k = patch.kind === undefined ? kind : patch.kind;
    if (k) p.set("kind", k);
    const d = patch.district === undefined ? district : patch.district;
    if (d) p.set("district", d);
    if (q) p.set("q", q);
    if (issue) p.set("issue", issue);
    if (patch.page && patch.page > 1) p.set("page", String(patch.page));
    const s = p.toString();
    return `${ROOT}/mail${s ? `?${s}` : ""}`;
  };

  const rows = (
    <ul>
      {list.items.map((m) => {
        const trust = trustInfo(m.senderTrust);
        const flagged = m.senderTrust !== "verified" && m.senderTrust !== "relay";
        const category = staffCategoryOf(m.messageTypes, m.isInternal);
        return (
          <li key={m.id} className={cn("grid gap-x-8 gap-y-1 border-b border-line py-4",
            canTriage ? "md:grid-cols-[20px_210px_minmax(0,1fr)_84px]" : "md:grid-cols-[210px_minmax(0,1fr)_84px]")}>
            {canTriage && <BulkCheck id={m.id} label={m.subject || "this message"} />}
            <p className={cn("min-w-0 text-base break-words text-ink", m.triageStatus === "new" && "font-semibold")}>{m.fromName ?? m.fromAddress}</p>
            <div className="min-w-0">
              <Link href={mailHref(m.id)} className={cn("text-base text-ink transition-colors hover:text-ink-2", m.triageStatus === "new" && "font-semibold")}>
                {m.subject || "No subject"}
              </Link>
              <p className="line-clamp-2 text-sm text-ink-2">{m.personalNote ?? (m.snippet || m.summary)}</p>
              <p className="flex flex-wrap gap-x-4 text-sm">
                {m.priority === "urgent" && (
                  <Status tone="danger" className="whitespace-normal!">{m.urgencyReason ?? "Urgent"}</Status>
                )}
                {flagged && <Status tone={trust.tone}>{trust.label}</Status>}
                {m.formLetter && <span className="text-ink-2">Form letter</span>}
                {m.personalNote && <Status tone="accent">Added a personal note</Status>}
                {m.isSensitive && <Status>Sensitive</Status>}
                {category !== "constituent" && <span className="text-ink-2">{STAFF_CATEGORIES[category]}</span>}
                <DistrictWord status={m.districtStatus} />
                {m.bills.filter((b) => b.linked).map((b) => (
                  <span key={b.reference} className="font-semibold text-ink">{b.reference}</span>
                ))}
                {m.issues.filter((i) => i.key.includes(".")).slice(0, 2).map((i) => <span key={i.key} className="text-ink-2">{i.label}</span>)}
                {m.cases.map((c) => <span key={c.caseNumber} className="text-ink-2">Case {c.caseNumber}</span>)}
                {m.assignedName && <span className="hand">{m.assignedName}</span>}
              </p>
            </div>
            <p className="text-sm text-ink-3 md:text-right" title={fullDate(m.receivedAt)}>{shortDate(m.receivedAt)}</p>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <PageTitle title="All mail">
        {can(ctx, "records.export") && (
          <ActionLink plain href={`${ROOT}/export/mail`} icon={Download}>Download as a spreadsheet</ActionLink>
        )}
      </PageTitle>
      <form action={`${ROOT}/mail`} className="mt-6 flex max-w-xl items-end gap-3">
        {folder !== "all" && <input type="hidden" name="folder" value={folder} />}
        {kind && <input type="hidden" name="kind" value={kind} />}
        {district && <input type="hidden" name="district" value={district} />}
        <Input name="q" defaultValue={q} aria-label="Search the mail" placeholder="Search the mail" />
        <Button type="submit">Search</Button>
      </form>
      {issue && (
        <p className="mt-4 text-base text-ink-2">
          Only mail tagged {list.items.flatMap((m) => m.issues).find((i) => i.key === issue)?.label ?? issue}.{" "}
          <Link href={`${ROOT}/mail`} className="text-ink underline underline-offset-4 decoration-line-strong hover:decoration-ink">Show all</Link>
        </p>
      )}
      <Tabs name="mail" className="mt-4 border-b border-line sm:flex-wrap sm:gap-y-0" current={folder} items={SHOWN.map((f) => ({ key: f,
        label: INBOX_FOLDERS[f], href: href({ folder: f }), count: f === "all" || f === "done" ? undefined : counts[f] }))} />

      <div className="mt-4 grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
        <span className="kicker text-ink-3">Kind</span>
        <Segmented label="Kind" showLabel={false} current={kind ?? "all"} items={[{ key: "all", label: "All", href: href({ kind: null, page: 1 }) },
          ...Object.entries(STAFF_CATEGORIES).map(([key, label]) => ({ key, label, href: href({ kind: key, page: 1 }) }))]} />
        <span className="kicker text-ink-3">District</span>
        <Segmented label="District" showLabel={false} current={district ?? "all"} items={[{ key: "all", label: "All", href: href({ district: null, page: 1 }) },
          ...Object.entries(DISTRICT_VIEWS).map(([key, label]) => ({ key, label, href: href({ district: key, page: 1 }) }))]} />
      </div>

      {list.items.length === 0 && <NoRows>{q ? `No mail matches ${q}.` : "No mail here."}</NoRows>}
      {canTriage && list.items.length > 0 ? (
        <BulkMail ids={list.items.map((m) => m.id)} team={team.filter((t) => t.status === "active").map((t) => ({ userId: t.userId, name: t.name }))}>
          {rows}
        </BulkMail>
      ) : (
        rows
      )}
      <div className="mt-6 flex gap-8">
        {page > 1 && <ActionLink href={href({ page: page - 1 })}>Newer</ActionLink>}
        {list.hasMore && <ActionLink href={href({ page: page + 1 })}>Older</ActionLink>}
      </div>
    </>
  );
}
