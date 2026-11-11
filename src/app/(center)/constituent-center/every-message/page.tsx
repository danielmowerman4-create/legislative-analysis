import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { DISPOSITION_LABEL, ledgerOverview, listLedger } from "@/server/services/center";
import type { LedgerDisposition } from "@/server/db/schema";
import { mailHref, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { RestoreButton } from "@/components/center/controls";
import { ActionLink, Table, Td, Th } from "@/components/ui";
import { Tabs } from "@/components/ui/blocks";
import { fullDate, shortDate } from "@/lib/format";

const ORDER: LedgerDisposition[] = ["filed", "held", "hidden", "screened", "duplicate", "failed", "pending"];
const PAGE = 100;

export default async function EveryMessagePage({ searchParams }: { searchParams: Promise<{ view?: string; page?: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "ledger.read")) notFound();
  const sp = await searchParams;
  const view = (ORDER as string[]).includes(sp.view ?? "") ? (sp.view as LedgerDisposition) : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const [o, list] = await Promise.all([ledgerOverview(ctx), listLedger(ctx, { disposition: view, limit: PAGE, offset: (page - 1) * PAGE })]);
  const accounted = o.total - (o.byDisposition.pending ?? 0) - (o.byDisposition.failed ?? 0);
  const check = o.lastCheck;
  const canRestore = can(ctx, "senders.manage");
  const href = (v: string | undefined, p = 1) => {
    const q = new URLSearchParams({ ...(v ? { view: v } : {}), ...(p > 1 ? { page: String(p) } : {}) }).toString();
    return `${ROOT}/every-message${q ? `?${q}` : ""}`;
  };
  return (
    <>
      <PageTitle title="Every message">
        <p className="text-xl text-ink">
          {o.total} received, {accounted} accounted for
          {check
            ? `. Last check of the mailbox: ${check.mailboxCount} there, ${check.mailboxCount - check.stillMissing} recorded, ${shortDate(check.createdAt)}`
            : ""}
        </p>
      </PageTitle>
      <Tabs
        name="ledger"
        className="mt-4 border-b border-line sm:flex-wrap sm:gap-y-0"
        current={view ?? "all"}
        items={[{ key: "all", label: "All", href: href(undefined) },
          ...ORDER.filter((d) => o.byDisposition[d]).map((d) => ({ key: d, label: DISPOSITION_LABEL[d], href: href(d), count: o.byDisposition[d] }))]}
      />
      {list.items.length === 0 ? (
        <NoRows>Nothing here.</NoRows>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>From</Th>
                <Th>Subject</Th>
                <Th>Where it went</Th>
                <Th>{canRestore ? "Action" : ""}</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap" title={fullDate(r.receivedAt ?? r.createdAt)}>{shortDate(r.receivedAt ?? r.createdAt)}</Td>
                  <Td className="min-w-[220px] [overflow-wrap:anywhere]">{r.fromAddress ?? "Not read yet"}</Td>
                  <Td className="max-w-[320px]">
                    {r.messageId ? (
                      <Link href={mailHref(r.messageId)} className="text-ink transition-colors hover:text-ink-2">{r.subject || "No subject"}</Link>
                    ) : (
                      (r.subject ?? "Not read yet")
                    )}
                  </Td>
                  <Td>
                    {r.direction === "outbound" && r.disposition === "filed" ? "A reply the office sent" : DISPOSITION_LABEL[r.disposition]}
                    {r.reason && <p className="text-sm text-ink-2">{r.reason}</p>}
                  </Td>
                  <Td>
                    {canRestore && (r.disposition === "hidden" || r.disposition === "screened") && r.messageId ? <RestoreButton ledgerId={r.id} /> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <div className="mt-6 flex gap-8">
        {page > 1 && <ActionLink href={href(view, page - 1)}>Newer</ActionLink>}
        {list.hasMore && <ActionLink href={href(view, page + 1)}>Older</ActionLink>}
      </div>
    </>
  );
}
