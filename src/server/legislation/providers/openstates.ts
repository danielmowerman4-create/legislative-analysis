import { getEnv } from "../../env";
import { checked, providerFetch } from "../../http";
import { chamberOf, mapOpenStatesClassification, parseBillNumber, statusFromActions } from "../normalize";
import { extractDocumentText } from "../text";
import type { ChangedBill, LegislativeProvider, NormalizedBill, NormalizedSession } from "../types";

// Field names follow the schema at https://v3.openstates.org/openapi.json.
const BASE = "https://v3.openstates.org";

type Org = { classification: string };
type OsBill = {
  id: string; session: string; identifier: string; title: string; classification: string[]; subject: string[]; updated_at: string; openstates_url: string;
  first_action_date: string | null; latest_action_date: string | null; latest_action_description: string | null; from_organization?: Org;
  abstracts?: { abstract: string; note: string }[];
  sponsorships?: { name: string; primary: boolean; classification: string; person?: { id: string; party?: string } | null }[];
  actions?: { id?: string; description: string; date: string; classification: string[]; order: number; organization?: Org }[];
  versions?: { id?: string; note: string; date: string; links: { url: string; media_type: string }[] }[];
  votes?: { id: string; motion_text: string; start_date: string; result: string; organization?: Org; counts: { option: string; value: number }[] }[];
  sources?: { url: string; note?: string }[];
};

const day = (d: string | null | undefined) => (d ? d.slice(0, 10) : null);

export class OpenStatesProvider implements LegislativeProvider {
  readonly key = "openstates" as const;

  private async get<T>(path: string, params: [string, string][]): Promise<T> {
    const key = getEnv().OPENSTATES_API_KEY;
    if (!key) throw new Error("OPENSTATES_API_KEY is not configured");
    const qs = new URLSearchParams(params);
    const res = await checked(await providerFetch(`${BASE}${path}?${qs}`, { headers: { "X-API-KEY": key } }), `Open States ${path}`);
    return (await res.json()) as T;
  }

  async listSessions(jurisdiction: string): Promise<NormalizedSession[]> {
    type OsSession = { identifier: string; name: string; classification: string; start_date: string; end_date: string };
    const path = `/jurisdictions/${encodeURIComponent(jurisdiction.toLowerCase())}`;
    const j = await this.get<{ legislative_sessions?: OsSession[] }>(path, [["include", "legislative_sessions"]]);
    return (j.legislative_sessions ?? []).map((s) => ({
      providerId: s.identifier, identifier: s.identifier, name: s.name, startDate: day(s.start_date), endDate: day(s.end_date),
      isSpecial: s.classification === "special",
    }));
  }

  async listChangedBills(jurisdiction: string, session: NormalizedSession, since: Date | null): Promise<ChangedBill[]> {
    const out: ChangedBill[] = [];
    for (let page = 1; page <= 200; page++) {
      const params: [string, string][] = [
        ["jurisdiction", jurisdiction.toLowerCase()], ["session", session.providerId], ["per_page", "20"], ["page", String(page)], ["sort", "updated_desc"],
      ];
      if (since) params.push(["updated_since", since.toISOString().slice(0, 19)]);
      const r = await this.get<{ results: { id: string; updated_at: string }[]; pagination: { max_page: number } }>("/bills", params);
      out.push(...r.results.map((b) => ({ providerBillId: b.id, changeHash: b.updated_at })));
      if (page >= r.pagination.max_page) break;
    }
    return out;
  }

  async getBill(_jurisdiction: string, providerBillId: string): Promise<NormalizedBill> {
    const include = ["sponsorships", "abstracts", "actions", "sources", "versions", "votes"].map((i) => ["include", i] as [string, string]);
    const b = await this.get<OsBill>(`/bills/${providerBillId}`, include);
    const id = b.identifier;
    const parsed = parseBillNumber(id) ?? { identifier: id, billType: id.split(" ")[0], number: Number(id.replace(/\D/g, "")) || 0 };
    const orgChamber = (c?: string) => (c === "upper" || c === "lower" ? c : null);
    const actions = [...(b.actions ?? [])]
      .sort((x, y) => x.order - y.order)
      .map((a, i) => ({
        providerKey: a.id ?? `${a.date}:${a.order}:${i}`, date: day(a.date)!, chamber: orgChamber(a.organization?.classification),
        description: a.description, classification: mapOpenStatesClassification(a.classification, a.description),
      }));
    return {
      providerBillId: b.id, sessionProviderId: b.session, identifier: parsed.identifier, billType: parsed.billType, number: parsed.number,
      chamber: orgChamber(b.from_organization?.classification) ?? chamberOf(parsed.billType), title: b.title,
      officialSummary: b.abstracts?.[0]?.abstract ?? null, status: statusFromActions(actions), statusText: b.latest_action_description,
      statusDate: day(b.latest_action_date), introducedAt: day(b.first_action_date), lastActionAt: day(b.latest_action_date),
      lastActionText: b.latest_action_description, effectiveDate: null, subjects: b.subject ?? [],
      sourceUrls: [
        { label: "Open States", url: b.openstates_url }, ...(b.sources ?? []).slice(0, 3).map((s) => ({ label: s.note || "Legislature", url: s.url })),
      ],
      changeHash: b.updated_at, sourceUpdatedAt: b.updated_at,
      sponsors: (b.sponsorships ?? []).map((s) => ({
        name: s.name, type: s.primary ? "primary" : "cosponsor", providerPersonId: s.person?.id ?? null, party: s.person?.party ?? null,
        district: null, chamber: null,
      })),
      actions,
      versions: (b.versions ?? []).map((v, i) => {
        const link = v.links.find((l) => /pdf|html/i.test(l.media_type)) ?? v.links[0];
        const providerVersionId = v.id ?? `${v.note}:${v.date}:${i}`;
        return { providerVersionId, label: v.note, date: day(v.date), url: link?.url ?? null, mimeType: link?.media_type ?? null };
      }),
      amendments: [],
      votes: (b.votes ?? []).map((v) => {
        const c = (o: string) => v.counts.find((x) => x.option === o)?.value ?? 0;
        return {
          providerRollCallId: v.id, date: day(v.start_date), chamber: orgChamber(v.organization?.classification), motion: v.motion_text,
          yes: c("yes"), no: c("no"), other: c("not voting") + c("absent") + c("excused") + c("other"), passed: v.result === "pass", url: null,
        };
      }),
      committees: [], events: [],
    };
  }

  async getVersionText(_j: string, version: { url: string | null; mimeType: string | null }): Promise<string | null> {
    if (!version.url) return null;
    const res = await checked(await providerFetch(version.url), "Bill text download");
    const bytes = new Uint8Array(await res.arrayBuffer());
    return extractDocumentText(bytes, version.mimeType ?? res.headers.get("content-type"));
  }
}
