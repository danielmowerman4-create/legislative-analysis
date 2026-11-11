import type { Metadata } from "next";
import Link from "next/link";
import { requireOffice } from "@/server/auth/next";
import { listCommittees } from "@/server/services/legislation";
import { EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { Section } from "@/components/ui/blocks";
import { NextEvent } from "@/components/bills";

export const metadata: Metadata = { title: "Committees" };

type Row = Awaited<ReturnType<typeof listCommittees>>["rows"][number];

export default async function CommitteesPage() {
  const { ctx } = await requireOffice();
  const { rows, closed } = await listCommittees(ctx);
  const mine = rows.filter((r) => r.role);
  const rest = rows.filter((r) => !r.role);
  const chambers: [string, string][] = [
    ["lower", "House"],
    ["upper", "Senate"],
    ["other", rest.some((r) => r.chamber === "lower" || r.chamber === "upper") ? "Joint and other" : "Joint committees"],
  ];
  return (
    <>
      <PageHeader title="Committees" meta={`${rows.length} committees`} />
      <div className="wrap">
        {rows.length === 0 ? (
          <EmptyState title="No committees have been loaded for this state yet." />
        ) : (
          <>
            {mine.length > 0 && (
              <Section title="Your committees" meta={`${mine.length} ${mine.length === 1 ? "committee" : "committees"}`}>
                <CommitteeTable rows={mine} closed={closed} />
              </Section>
            )}
            {chambers.map(([key, label]) => {
              const list = rest.filter((r) => (key === "other" ? r.chamber !== "lower" && r.chamber !== "upper" : r.chamber === key));
              if (!list.length) return null;
              return (
                <Section key={key} title={label} meta={`${list.length} ${list.length === 1 ? "committee" : "committees"}`}>
                  <CommitteeTable rows={list} closed={closed} />
                </Section>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}

function CommitteeTable({ rows, closed }: { rows: Row[]; closed: boolean }) {
  return (
    <Table className="table-fixed">
      <thead>
        <tr>
          <Th>Committee</Th>
          <Th align="right" className="hidden w-[88px] md:table-cell">Bills</Th>
          <Th align="right" className="hidden w-[116px] md:table-cell">{closed ? "Became law" : "Pending"}</Th>
          <Th align="right" className="w-[92px]">Tracked</Th>
          {!closed && <Th className="hidden w-[200px] sm:table-cell">Next hearing</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <Td>
              <Link href={`/committees/${c.id}`} className="font-display text-md font-medium text-ink decoration-rule underline-offset-4 hover:underline">
                {c.name}
              </Link>
              {c.role && <span className="block text-sm text-ink-2">{c.role}</span>}
            </Td>
            <Td align="right" className="hidden md:table-cell">{c.bills}</Td>
            <Td align="right" className="hidden md:table-cell">{closed ? c.enacted : c.active}</Td>
            <Td align="right" className={c.tracked ? "font-semibold text-ink" : "text-ink-3"}>{c.tracked}</Td>
            {!closed && <Td className="hidden sm:table-cell"><NextEvent at={c.next_hearing} /></Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
