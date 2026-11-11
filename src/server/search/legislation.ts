import { sql } from "drizzle-orm";
import { withTenant } from "../db/client";
import { can, tenantScope, type OfficeContext } from "../authz/context";

export type SearchHit = { type: "Bills" | "Legislators" | "Committees"; id: string; title: string; subtitle?: string; href: string; score: number };

const chamberName = (c: string | null) => (c === "upper" ? "Senate" : c === "lower" ? "House" : null);

export async function searchEverything(ctx: OfficeContext, q: string, perType = 6): Promise<{ results: SearchHit[] }> {
  const query = q.trim().slice(0, 200);
  if (query.length < 2 || !can(ctx, "legislation.read")) return { results: [] };
  const number = query.match(/^([a-z]{1,4})\.?\s*0*(\d{1,5})$/i);
  const identifier = number ? `${number[1].toUpperCase()} ${Number(number[2])}` : null;
  return withTenant(tenantScope(ctx), async (tx) => {
    const results: SearchHit[] = [];
    const billRows = await tx.execute<{ id: string; identifier: string; title: string; session: string; status: string }>(sql`
      select b.id, b.identifier, b.title, s.identifier as session, b.status from bills b join legislative_sessions s on s.id = b.session_id
      join organizations o on o.id = ${ctx.orgId} and o.jurisdiction_code = b.jurisdiction_code
      where ${identifier ? sql`b.identifier = ${identifier}` : sql`b.search_tsv @@ websearch_to_tsquery('english', ${query})`}
      order by s.start_date desc nulls last, ts_rank(b.search_tsv, websearch_to_tsquery('english', ${query})) desc limit ${perType}`);
    results.push(...billRows.rows.map((r, i) => ({
      type: "Bills" as const, id: r.id, title: `${r.identifier} · ${r.title}`, subtitle: r.session, href: `/bills/${r.id}`, score: 1 / (i + 1),
    })));
    if (!identifier) {
      const people = await tx.execute<{ id: string; name: string; party: string | null; chamber: string | null; district: string | null }>(sql`
        select l.id, l.name, l.party, l.chamber, l.district from legislators l
        join organizations o on o.id = ${ctx.orgId} and o.jurisdiction_code = l.jurisdiction_code
        where l.active and (l.name ilike ${`%${query}%`} or l.district = ${query.replace(/^(hd|sd|district)\s*/i, "")})
        order by l.name limit ${perType}`);
      results.push(...people.rows.map((r, i) => ({
        type: "Legislators" as const, id: r.id, title: r.name,
        subtitle: [chamberName(r.chamber), r.district ? `District ${r.district}` : null, r.party].filter(Boolean).join(" · "),
        href: `/legislators/${r.id}`, score: 1 / (i + 1),
      })));
      const cmte = await tx.execute<{ id: string; name: string; chamber: string | null }>(sql`
        select c.id, c.name, c.chamber from committees c join organizations o on o.id = ${ctx.orgId} and o.jurisdiction_code = c.jurisdiction_code
        where c.name ilike ${`%${query}%`} order by c.name limit ${perType}`);
      results.push(...cmte.rows.map((r, i) => ({
        type: "Committees" as const, id: r.id, title: r.name, subtitle: chamberName(r.chamber) ?? undefined, href: `/committees/${r.id}`, score: 1 / (i + 1),
      })));
    }
    return { results };
  });
}
