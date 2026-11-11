import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { CASE_STATUSES, listCases } from "@/server/services/cases";
import { NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { Status, Table, Td, Th } from "@/components/ui";
import { Tabs } from "@/components/ui/blocks";
import { shortDate } from "@/lib/format";

const VIEWS = { open: "Open", me: "Mine", resolved: "Resolved" } as const;

export default async function CaseworkPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "cases.read")) notFound();
  const { view } = await searchParams;
  const current = (view && Object.hasOwn(VIEWS, view) ? view : "open") as keyof typeof VIEWS;
  const list = await listCases(ctx, current === "me" ? { status: "open", assignee: "me" } : { status: current });
  return (
    <>
      <PageTitle title="Casework" />
      <Tabs name="cases" className="mt-4 border-b border-line" current={current}
        items={Object.entries(VIEWS).map(([key, label]) => ({ key, label, href: `${ROOT}/casework${key === "open" ? "" : `?view=${key}`}` }))} />
      {list.items.length === 0 ? (
        <NoRows>No cases here.</NoRows>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Case</Th>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th>Handled by</Th>
                <Th>Follow up</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`${ROOT}/casework/${c.id}`} className="text-base font-semibold text-ink transition-colors hover:text-ink-2">{c.title}</Link>
                    <p className="text-sm text-ink-2">{c.caseNumber}, {c.category}{c.agency ? `, ${c.agency}` : ""}</p>
                  </Td>
                  <Td>{c.contactName ?? "Not recorded"}</Td>
                  <Td>{c.priority === "urgent" ? <Status tone="danger">Urgent</Status> : CASE_STATUSES[c.status]}</Td>
                  <Td>{c.assignee ? <span className="hand">{c.assignee}</span> : "Nobody yet"}</Td>
                  <Td>{c.followUpAt ? shortDate(c.followUpAt) : "None set"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </>
  );
}
