import { strFromU8, unzipSync } from "fflate";
import { getEnv } from "../../env";
import { checked, providerFetch } from "../../http";
import { KNOWN_JURISDICTIONS } from "../../services/offices";
import { chamberOf, classifyAction, legiscanStatus, localTimeToIso, parseBillNumber, validDate } from "../normalize";
import type { ChangedBill, LegislativeProvider, NormalizedBill, NormalizedPerson, NormalizedSession } from "../types";
import { LEGISCAN_SAST_KIND } from "../related";
import { extractDocumentText } from "../text";

// Fields and codes follow the LegiScan API User Manual, 2025-06 edition.
const BASE = "https://api.legiscan.com/";

type LsSession = {
  session_id: number; year_start: number; year_end: number; sine_die: number; prior: number; special: number; session_name: string; session_title: string;
};
type LsDataset = { session_id: number; special: number; year_start: number; year_end: number; dataset_hash: string; dataset_date: string; access_key: string };
// The manual's table says committee_name, its example JSON says name.
type LsCommittee = { committee_id: number; chamber: string; name?: string; committee_name?: string };
type LsBill = {
  bill_id: number;
  change_hash: string;
  session_id: number;
  url: string;
  state_link: string;
  status: number | string;
  status_date: string | null;
  bill_number: string;
  body: string;
  title: string;
  description: string;
  committee?: LsCommittee | [];
  referrals?: (LsCommittee & { date: string })[];
  history?: { date: string; action: string; chamber: string; importance: number }[];
  sponsors?: {
    people_id: number; name: string; party: string; district: string; role: string; sponsor_type_id: number; sponsor_order: number; committee_sponsor?: number;
  }[];
  subjects?: { subject_id: number; subject_name: string }[];
  texts?: { doc_id: number; date: string; type: string; mime: string; url: string; state_link: string }[];
  votes?: {
    roll_call_id: number; date: string; desc: string; yea: number; nay: number; nv: number; absent: number; passed: number; chamber: string; url: string;
    state_link: string;
  }[];
  amendments?: { amendment_id: number; adopted: number; chamber: string; date: string; title: string; description: string; url: string; state_link: string }[];
  calendar?: { type_id?: number; type: string; date: string; time: string; location: string; description: string }[];
  sasts?: { type_id: number; type: string; sast_bill_number: string; sast_bill_id: number }[];
};

const chamberCode = (c: string | undefined) => (c === "S" ? "upper" : c === "H" || c === "A" ? "lower" : c || null);
const roleChamber = (role: string) => (role === "Sen" ? "upper" : role === "Rep" ? "lower" : null);
const committeeName = (c: LsCommittee) => c.name || c.committee_name || `Committee ${c.committee_id}`;
// sponsor_type_id 1 is primary; a generic (0) first sponsor is the author.
const isPrimary = (s: { sponsor_type_id: number; sponsor_order: number }) => s.sponsor_type_id === 1 || (s.sponsor_type_id === 0 && s.sponsor_order === 1);

function normalizeLegiScanBill(b: LsBill, timeZone: string): NormalizedBill {
  const n = b.bill_number;
  const parsed = parseBillNumber(n) ?? { identifier: n, billType: n.replace(/\d+/g, ""), number: Number(n.replace(/\D/g, "")) || 0 };
  const history = (b.history ?? []).filter((h) => validDate(h.date)).sort((x, y) => x.date.localeCompare(y.date));
  const last = history[history.length - 1];
  return {
    providerBillId: String(b.bill_id), sessionProviderId: String(b.session_id), identifier: parsed.identifier, billType: parsed.billType,
    number: parsed.number, chamber: chamberOf(parsed.billType), title: b.title,
    officialSummary: b.description && b.description !== b.title ? b.description : null,
    status: legiscanStatus(Number(b.status), Boolean(b.referrals?.length)), statusText: null, statusDate: validDate(b.status_date),
    introducedAt: history[0]?.date ?? null, lastActionAt: last?.date ?? null, lastActionText: last?.action ?? null, effectiveDate: null,
    subjects: (b.subjects ?? []).map((s) => s.subject_name),
    sourceUrls: [{ label: "Legislature", url: b.state_link }, { label: "LegiScan", url: b.url }].filter((u) => u.url),
    changeHash: b.change_hash, sourceUpdatedAt: null,
    sponsors: [...(b.sponsors ?? [])]
      .sort((x, y) => x.sponsor_order - y.sponsor_order)
      .map((s) => ({
        name: s.name, type: isPrimary(s) ? "primary" : "cosponsor", providerPersonId: String(s.people_id),
        party: s.party || null, district: s.district || null, chamber: roleChamber(s.role),
      })),
    actions: history.map((h, i) => ({
      providerKey: `${h.date}:${i}:${h.action.slice(0, 80)}`, date: h.date, chamber: chamberCode(h.chamber), description: h.action,
      classification: classifyAction(h.action),
    })),
    versions: (b.texts ?? []).map((t) => ({
      providerVersionId: String(t.doc_id), label: t.type, date: validDate(t.date), url: t.state_link || t.url, mimeType: t.mime,
    })),
    amendments: (b.amendments ?? []).map((a) => ({
      providerAmendmentId: String(a.amendment_id), title: a.title, description: a.description || null, chamber: chamberCode(a.chamber),
      adopted: a.adopted === 1, date: validDate(a.date), url: a.state_link || a.url,
    })),
    votes: (b.votes ?? []).map((v) => ({
      providerRollCallId: String(v.roll_call_id), date: validDate(v.date), chamber: chamberCode(v.chamber), motion: v.desc,
      yes: v.yea, no: v.nay, other: v.nv + v.absent, passed: v.passed === 1, url: v.state_link || v.url,
    })),
    committees: (b.referrals ?? []).map((r) => ({
      providerCommitteeId: String(r.committee_id), name: committeeName(r), chamber: chamberCode(r.chamber), referredAt: validDate(r.date),
    })),
    events: (b.calendar ?? []).flatMap((c, i) => {
      const startsAt = localTimeToIso(c.date, c.time, timeZone);
      if (!startsAt) return [];
      const kind = c.type_id === 1 || /hearing/i.test(`${c.type} ${c.description}`) ? ("hearing" as const) : ("floor" as const);
      return [{ providerEventId: `ls:${b.bill_id}:${c.date}:${i}`, title: c.description || c.type, startsAt, location: c.location || null, kind }];
    }),
    relations: (b.sasts ?? []).flatMap((x) => {
      const kind = LEGISCAN_SAST_KIND[x.type_id];
      if (!kind || !x.sast_bill_id) return [];
      return [{ providerBillId: String(x.sast_bill_id), identifier: parseBillNumber(x.sast_bill_number)?.identifier ?? x.sast_bill_number, kind }];
    }),
  };
}

export class LegiScanProvider implements LegislativeProvider {
  readonly key = "legiscan" as const;
  queries = 0;
  private readonly apiKey: string | undefined;

  constructor(opts: { apiKey?: string } = {}) {
    this.apiKey = opts.apiKey;
  }

  private async call<T>(op: string, params: Record<string, string | number>): Promise<T> {
    const key = this.apiKey ?? getEnv().LEGISCAN_API_KEY;
    if (!key) throw new Error("LEGISCAN_API_KEY is not configured");
    const qs = new URLSearchParams({ key, op, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    this.queries++;
    const res = await checked(await providerFetch(`${BASE}?${qs}`), `LegiScan ${op}`);
    const body = (await res.json()) as { status: string; alert?: { message: string } } & T;
    if (body.status !== "OK") throw new Error(`LegiScan ${op} returned ${body.status}: ${body.alert?.message ?? "no detail"}`);
    return body;
  }

  private timeZone(jurisdiction: string) {
    return KNOWN_JURISDICTIONS[jurisdiction]?.timezone ?? "America/New_York";
  }

  async listSessions(jurisdiction: string): Promise<NormalizedSession[]> {
    const r = await this.call<{ sessions: LsSession[] }>("getSessionList", { state: jurisdiction });
    return r.sessions.map((s) => ({
      providerId: String(s.session_id), identifier: s.special ? s.session_title : `${s.year_start}${s.year_end !== s.year_start ? `-${s.year_end}` : ""}`,
      name: s.session_title,
      // LegiScan gives years, not convening dates, so the window is the calendar years.
      startDate: `${s.year_start}-01-01`, endDate: `${s.year_end}-12-31`, isSpecial: Boolean(s.special),
    }));
  }

  async bulkBills(jurisdiction: string, session: NormalizedSession): Promise<NormalizedBill[] | null> {
    const { datasetlist } = await this.call<{ datasetlist: LsDataset[] }>("getDatasetList", { state: jurisdiction });
    const ds = datasetlist.find((d) => String(d.session_id) === session.providerId);
    if (!ds) return null;
    const { dataset } = await this.call<{ dataset: { zip: string } }>("getDataset", { id: ds.session_id, access_key: ds.access_key });
    // One getBill payload per file under bill/; people/ and vote/ are skipped.
    const files = unzipSync(Buffer.from(dataset.zip, "base64"), { filter: (f) => /(^|\/)bill\/[^/]+\.json$/i.test(f.name) });
    const tz = this.timeZone(jurisdiction);
    const out: NormalizedBill[] = [];
    for (const data of Object.values(files)) {
      const parsed = JSON.parse(strFromU8(data)) as { bill?: LsBill } & Partial<LsBill>;
      const b = (parsed.bill ?? parsed) as LsBill;
      if (typeof b.bill_id === "number") out.push(normalizeLegiScanBill(b, tz));
    }
    return out;
  }

  async listChangedBills(_j: string, session: NormalizedSession, _since: Date | null, known: Map<string, string | null>): Promise<ChangedBill[]> {
    type Entry = { bill_id?: number; number?: string; change_hash?: string };
    const r = await this.call<{ masterlist: Record<string, Entry> }>("getMasterListRaw", { id: session.providerId });
    return Object.values(r.masterlist)
      .filter((b): b is { bill_id: number; change_hash: string } => typeof b?.bill_id === "number")
      .map((b) => ({ providerBillId: String(b.bill_id), changeHash: b.change_hash ?? null }))
      .filter((b) => known.get(b.providerBillId) !== b.changeHash);
  }

  async getBill(jurisdiction: string, providerBillId: string): Promise<NormalizedBill> {
    const { bill } = await this.call<{ bill: LsBill }>("getBill", { id: providerBillId });
    return normalizeLegiScanBill(bill, this.timeZone(jurisdiction));
  }

  async getVersionText(_j: string, version: { providerVersionId: string }): Promise<string | null> {
    const { text } = await this.call<{ text: { mime: string; doc: string } }>("getBillText", { id: version.providerVersionId });
    return extractDocumentText(Buffer.from(text.doc, "base64"), text.mime);
  }

  async listPeople(_j: string, session: NormalizedSession): Promise<NormalizedPerson[]> {
    type Person = { people_id: number; name: string; party: string; role: string; district: string };
    const { sessionpeople } = await this.call<{ sessionpeople: { people: Person[] } }>("getSessionPeople", { id: session.providerId });
    return sessionpeople.people.map((p) => ({
      providerPersonId: String(p.people_id), name: p.name, party: p.party || null, chamber: roleChamber(p.role),
      district: p.district ? p.district.replace(/^[A-Z]+-0*/i, "") || p.district : null, // "HD-030" -> "30"
    }));
  }

  async getRollCallVotes(providerRollCallId: string) {
    type Vote = { people_id: number; vote_id: number; vote_text: string };
    const { roll_call } = await this.call<{ roll_call: { votes: Vote[] } }>("getRollCall", { id: providerRollCallId });
    // vote_id: 1 Yea, 2 Nay, 3 NV, 4 Absent.
    const map = (id: number, t: string): "yes" | "no" | "not_voting" | "absent" | "other" => {
      if (id === 1 || /^yea/i.test(t)) return "yes";
      if (id === 2 || /^nay/i.test(t)) return "no";
      if (id === 3 || /^nv/i.test(t)) return "not_voting";
      return id === 4 || /absent/i.test(t) ? "absent" : "other";
    };
    return roll_call.votes.map((v) => ({ name: `person:${v.people_id}`, providerPersonId: String(v.people_id), vote: map(v.vote_id, v.vote_text) }));
  }
}
