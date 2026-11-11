import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCenter } from "@/server/auth/center";
import { can } from "@/server/authz/context";
import { listContacts } from "@/server/services/contacts";
import { DISTRICT_VIEWS, DistrictWord, NoRows, PageTitle, ROOT } from "@/components/center/parts";
import { ActionLink, Button, Input, Table, Td, Th } from "@/components/ui";
import { Segmented } from "@/components/ui/blocks";
import { shortDate } from "@/lib/format";

const PAGE = 50;

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; district?: string }> }) {
  const { ctx } = await requireCenter();
  if (!can(ctx, "contacts.read")) notFound();
  const sp = await searchParams;
  const q = sp.q?.trim() || undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const district = sp.district && Object.hasOwn(DISTRICT_VIEWS, sp.district) ? (sp.district as keyof typeof DISTRICT_VIEWS) : undefined;
  const list = await listContacts(ctx, { q, district, limit: PAGE, offset: (page - 1) * PAGE });
  const href = (p: number, d: string | null |
    undefined = district) => `${ROOT}/people?${new URLSearchParams({ ...(q ? { q } : {}), ...(d ? { district: d } : {}), page: String(p) })}`;
  return (
    <>
      <PageTitle title="People" />
      <form action={`${ROOT}/people`} className="mt-6 flex max-w-xl items-end gap-3">
        <Input name="q" defaultValue={q} aria-label="Search people" placeholder="Search by name, email or town" />
        {district && <input type="hidden" name="district" value={district} />}
        <Button type="submit">Search</Button>
      </form>
      <div className="mt-4">
        <Segmented label="District" current={district ?? "all"} items={[{ key: "all", label: "All", href: href(1, null) },
          ...Object.entries(DISTRICT_VIEWS).map(([key, label]) => ({ key, label, href: href(1, key) }))]} />
      </div>
      {list.items.length === 0 ? (
        <NoRows>{q ? `Nobody matches ${q}.` : "Nobody yet."}</NoRows>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>District</Th>
                <Th align="right">Messages</Th>
                <Th align="right">Open cases</Th>
                <Th>Last heard from</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`${ROOT}/people/${c.id}`} className="text-base font-semibold text-ink transition-colors hover:text-ink-2">
                      {c.fullName ?? c.organizationName ?? c.email ?? "No name recorded"}
                    </Link>
                    {c.email && <p className="text-sm text-ink-2">{c.email}</p>}
                  </Td>
                  <Td>
                    <DistrictWord status={c.districtStatus} />
                  </Td>
                  <Td align="right">{c.messages}</Td>
                  <Td align="right">{c.openCases}</Td>
                  <Td>{c.lastContactAt ? shortDate(c.lastContactAt) : "Not recorded"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <div className="mt-6 flex gap-8">
        {page > 1 && <ActionLink href={href(page - 1)}>Previous</ActionLink>}
        {list.hasMore && <ActionLink href={href(page + 1)}>Next</ActionLink>}
      </div>
    </>
  );
}
