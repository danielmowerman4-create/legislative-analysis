import Link from "next/link";
import { Download } from "lucide-react";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { topics } from "@/server/services/center";
import { Block, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { ActionLink, Table, Td, Th } from "@/components/ui";

export default async function TopicsPage() {
  const { ctx } = await requireCenter();
  const d = await topics(ctx);
  return (
    <>
      <PageTitle title="Topics">
        {can(ctx, "records.export") && (
          <ActionLink plain href={`${ROOT}/export/bills`} icon={Download}>Download who wrote about each bill</ActionLink>
        )}
      </PageTitle>
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
