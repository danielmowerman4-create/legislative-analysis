import Link from "next/link";
import { Download } from "lucide-react";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { mailByWeek, topics } from "@/server/services/center";
import { CountBar, SplitBar, SplitKey, WeekBars } from "@/components/center/graphs";
import { Block, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { ActionLink, Table, Td, Th } from "@/components/ui";

export default async function TopicsPage() {
  const { ctx } = await requireCenter();
  const [d, weeks] = await Promise.all([topics(ctx), mailByWeek(ctx)]);
  const everyone = weeks.reduce((t, w) => ({ support: t.support + w.support, oppose: t.oppose + w.oppose, other: t.other + w.other }),
    { support: 0, oppose: 0, other: 0 });
  const mostPeople = Math.max(1, ...d.issues.map((i) => i.people));
  return (
    <>
      <PageTitle title="Topics">
        {can(ctx, "records.export") && (
          <ActionLink plain href={`${ROOT}/export/bills`} icon={Download}>Download who wrote about each bill</ActionLink>
        )}
      </PageTitle>
      {weeks.length > 1 && (
        <Block title="People who wrote, by week">
          <WeekBars weeks={weeks} />
          <SplitKey sides={everyone} other="No side on a bill" />
        </Block>
      )}
      <Block title="Bills">
        {d.bills.length === 0 ? (
          <NoRows>Nobody has written about a bill yet.</NoRows>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Bill</Th>
                  <Th align="right">People</Th>
                  <Th align="right">In district</Th>
                  <Th align="right">Support</Th>
                  <Th align="right">Oppose</Th>
                  <Th align="right">Other</Th>
                  <Th align="right">By form letter</Th>
                </tr>
              </thead>
              <tbody>
                {d.bills.map((b) => (
                  <tr key={b.reference}>
                    <Td>
                      <Link href={`${ROOT}/topics/${encodeURIComponent(b.reference)}`}
                        className="text-base font-semibold text-ink transition-colors hover:text-ink-2">
                        {b.reference}
                      </Link>
                      {b.title && <p className="line-clamp-1 text-sm text-ink-2">{b.title}</p>}
                      <SplitBar sides={b} label={b.reference} className="mt-2 max-w-[22rem]" />
                    </Td>
                    <Td align="right">{b.people}</Td>
                    <Td align="right">{b.in_district}</Td>
                    <Td align="right">{b.support}</Td>
                    <Td align="right">{b.oppose}</Td>
                    <Td align="right">{b.other}</Td>
                    <Td align="right">{b.form_letters}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Block>
      <Block title="Issues">
        {d.issues.length === 0 ? (
          <NoRows>No issues yet.</NoRows>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Issue</Th>
                  <Th align="right">People</Th>
                  <Th align="right">In district</Th>
                </tr>
              </thead>
              <tbody>
                {d.issues.map((i) => (
                  <tr key={i.key}>
                    <Td className="text-base">
                      <Link href={`${ROOT}/mail?issue=${encodeURIComponent(i.key)}`} className="text-ink transition-colors hover:text-ink-2">
                        {i.label ?? i.key}
                      </Link>
                      <span className="mt-1.5 block max-w-[22rem]"><CountBar value={i.people} max={mostPeople} /></span>
                    </Td>
                    <Td align="right">{i.people}</Td>
                    <Td align="right">{i.in_district}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Block>
    </>
  );
}
