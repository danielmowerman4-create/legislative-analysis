import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { freshDatabase } from "../helpers/db";
import { systemDb } from "@/server/db/client";
import { billCommitteeLinks, bills, billSponsors, committees, legislativeEvents, legislators, rollCalls } from "@/server/db/schema";
import { setProviderFetchForTests } from "@/server/http";
import { LegiScanProvider } from "@/server/legislation/providers/legiscan";
import { syncJurisdiction } from "@/server/legislation/sync";
import { localTimeToIso } from "@/server/legislation/normalize";

// Payloads follow the LegiScan API manual (2025-06); bills are synthetic.
type Json = Record<string, unknown>;

const session = { session_id: 2101, state_id: 10, year_start: 2025, year_end: 2026, prefile: 0, sine_die: 1, prior: 0, special: 0,
  session_tag: "Regular Session", session_title: "2025-2026 Regular Session", session_name: "2025-2026 Session", dataset_hash: "ds1" };
const older = { ...session, session_id: 1900, year_start: 2023, year_end: 2024, prior: 1, session_title: "2023-2024 Regular Session",
  session_name: "2023-2024 Session" };

function bill(id: number, number: string, hash: string, extra: Json = {}): Json {
  return {
    bill_id: id,
    change_hash: hash,
    session_id: 2101,
    session: { session_id: 2101, state_id: 10, year_start: 2025, year_end: 2026, prefile: 0, sine_die: 1, prior: 0, special: 0, session_tag: "Regular Session",
      session_title: "2025-2026 Regular Session", session_name: "2025-2026 Session" },
    url: `https://legiscan.com/GA/bill/${number}/2025`,
    state_link: `https://www.legis.ga.gov/legislation/${id}`,
    completed: 0,
    status: 1,
    status_date: "2025-01-15",
    progress: [{ date: "2025-01-15", event: 1 }],
    state: "GA",
    state_id: 10,
    bill_number: number,
    bill_type: "B",
    bill_type_id: "1",
    body: number.startsWith("S") ? "S" : "H",
    body_id: 1,
    current_body: number.startsWith("S") ? "S" : "H",
    current_body_id: 1,
    title: `Synthetic test measure ${number}`,
    description: `A synthetic description for ${number}.`,
    pending_committee_id: 0,
    committee: [],
    referrals: [],
    history: [{ date: "2025-01-15", action: "House First Readers", chamber: "H", chamber_id: 1, importance: 1 }],
    sponsors: [],
    sasts: [],
    subjects: [{ subject_id: 1, subject_name: "Education" }],
    texts: [],
    votes: [],
    amendments: [],
    supplements: [],
    calendar: [],
    ...extra,
  };
}

const hb1 = bill(9001, "HB1", "a1", {
  // Field table name (committee_name), not the example's (name).
  referrals: [{ date: "2025-01-16", committee_id: 55, chamber: "H", chamber_id: 1, committee_name: "Education" }],
  sponsors: [
    { people_id: 301, person_hash: "x1", party_id: 2, party: "R", role_id: 1, role: "Rep", name: "Pat Example", first_name: "Pat", middle_name: "",
      last_name: "Example", suffix: "", nickname: "", district: "HD-048", sponsor_type_id: 0, sponsor_order: 1, committee_sponsor: 0, committee_id: "0" },
    { people_id: 302, person_hash: "x2", party_id: 1, party: "D", role_id: 1, role: "Rep", name: "Lee Sample", first_name: "Lee", middle_name: "",
      last_name: "Sample", suffix: "", nickname: "", district: "HD-010", sponsor_type_id: 0, sponsor_order: 2, committee_sponsor: 0, committee_id: "0" },
  ],
  history: [
    { date: "2025-01-15", action: "House First Readers", chamber: "H", chamber_id: 1, importance: 1 },
    { date: "2025-01-16", action: "House Second Readers", chamber: "H", chamber_id: 1, importance: 0 },
  ],
  texts: [{ doc_id: 7001, date: "2025-01-15", type: "Introduced", type_id: 1, mime: "text/html", mime_id: 1, url: "https://legiscan.com/GA/text/HB1/id/7001",
    state_link: "https://www.legis.ga.gov/api/legislation/document/x.pdf", text_size: 100, text_hash: "t" }],
  votes: [{ roll_call_id: 8001, date: "0000-00-00", desc: "House Vote #12", yea: 150, nay: 20, nv: 5, absent: 5, total: 180, passed: 1, chamber: "H",
    chamber_id: 1, url: "https://legiscan.com/GA/rollcall/HB1/id/8001", state_link: "" }],
  calendar: [
    { type_id: 1, type: "Hearing", date: "2026-03-19", time: "13:00:00", location: "406 CLOB", description: "House Education Committee" },
    { type_id: 1, type: "Hearing", date: "2026-01-20", time: "", location: "", description: "House Education Committee" },
  ],
});
const sb5Old = bill(9002, "SB5", "b-old");
const sb5New = bill(9002, "SB5", "b-new", {
  status: "2",
  status_date: "2025-02-20",
  history: [
    { date: "2025-01-15", action: "Senate Read and Referred", chamber: "S", chamber_id: 2, importance: 1 },
    { date: "2025-02-20", action: "Senate Passed/Adopted", chamber: "S", chamber_id: 2, importance: 1 },
  ],
});
const hr10 = bill(9003, "HR10", "c1");

function datasetZip(billsInZip: Json[]) {
  const files: Record<string, Uint8Array> = {};
  for (const b of billsInZip) files[`GA/2025-2026_Regular_Session/bill/${b.bill_number}.json`] = strToU8(JSON.stringify({ bill: b }));
  files["GA/2025-2026_Regular_Session/people/301.json"] = strToU8(JSON.stringify({ person: { people_id: 301 } }));
  files["GA/2025-2026_Regular_Session/vote/8001.json"] = strToU8(JSON.stringify({ roll_call: { roll_call_id: 8001 } }));
  return Buffer.from(zipSync(files)).toString("base64");
}

class FakeLegiScan {
  ops: string[] = [];
  datasetAvailable = true;
  masterlist: Record<string, string> = { "9001": "a1", "9002": "b-new", "9003": "c1" };
  current: Record<string, Json> = { "9001": hb1, "9002": sb5New, "9003": hr10 };

  fetch = async (input: string) => {
    const u = new URL(input);
    const op = u.searchParams.get("op")!;
    this.ops.push(op === "getBill" ? `getBill:${u.searchParams.get("id")}` : op);
    if (u.searchParams.get("key") !== "test-key") return Response.json({ status: "ERROR", alert: { message: "Invalid API key" } });
    switch (op) {
      case "getSessionList":
        return Response.json({ status: "OK", sessions: [session, older] });
      case "getDatasetList":
        if (!this.datasetAvailable) return Response.json({ status: "ERROR", alert: { message: "Dataset access unavailable" } });
        return Response.json({ status: "OK",
          datasetlist: [{ state_id: 10, session_id: 2101, special: 0, year_start: 2025, year_end: 2026, session_name: "2025-2026 Regular Session",
          session_title: "Regular Session", dataset_hash: "ds1", dataset_date: "2025-02-01", dataset_size: 1, access_key: "AK1" }] });
      case "getDataset":
        if (u.searchParams.get("access_key") !== "AK1") return Response.json({ status: "ERROR", alert: { message: "Bad access key" } });
        return Response.json({ status: "OK", dataset: { state_id: 10, session_id: 2101, session_name: "2025-2026 Regular Session", dataset_hash: "ds1",
          dataset_date: "2025-02-01", dataset_size: 1, mime: "application/zip", zip: datasetZip([hb1, sb5Old]) } });
      case "getMasterListRaw": {
        const list: Json = { session: { session_id: 2101, session_name: "2025-2026 Regular Session" } };
        Object.entries(this.masterlist).forEach(([id, hash], i) =>
          (list[String(i)] = { bill_id: Number(id), number: (this.current[id] as { bill_number: string }).bill_number, change_hash: hash }));
        return Response.json({ status: "OK", masterlist: list });
      }
      case "getBill":
        return Response.json({ status: "OK", bill: this.current[u.searchParams.get("id")!] });
      case "getSessionPeople":
        return Response.json({ status: "OK", sessionpeople: { session: { session_id: 2101 },
          people: [{ people_id: 501, name: "Synthetic Member", party: "R", role: "Rep", district: "HD-007" }] } });
      case "getBillText":
        return Response.json({ status: "OK", text: { doc_id: 7001, bill_id: 9001, date: "2025-01-15", type: "Introduced", type_id: 1, mime: "text/html",
          mime_id: 1, text_size: 10, text_hash: "t", doc: Buffer.from("<html><body><p>Section 1. Synthetic text.</p></body></html>").toString("base64") } });
      default:
        return Response.json({ status: "ERROR", alert: { message: `Unknown op ${op}` } });
    }
  };
}

async function billByIdentifier(identifier: string) {
  const db = await systemDb();
  const [b] = await db.select().from(bills).where(and(eq(bills.jurisdictionCode, "GA"), eq(bills.identifier, identifier)));
  return b;
}

describe("LegiScan adapter (manual-shaped responses)", () => {
  const fake = new FakeLegiScan();
  beforeAll(async () => {
    await freshDatabase();
    setProviderFetchForTests(fake.fetch);
  });
  afterAll(() => setProviderFetchForTests(null));

  it("first load uses the weekly dataset, then fetches only bills changed since it", async () => {
    const provider = new LegiScanProvider({ apiKey: "test-key" });
    const r = await syncJurisdiction("GA", { provider, sessionIdentifiers: ["2025-2026"] });
    expect(r.status).toBe("succeeded");
    expect(fake.ops).toEqual(["getSessionList", "getSessionPeople", "getDatasetList", "getDataset", "getMasterListRaw", "getBill:9002", "getBill:9003"]);
    expect(r.queries).toBe(7);
    const [member] = await (await systemDb()).select().from(legislators).where(eq(legislators.providerPersonId, "501"));
    expect(member).toMatchObject({ name: "Synthetic Member", party: "R", chamber: "lower", district: "7" });
    expect(r.bulkLoaded).toBe(2);
    expect(r.newActionIds).toEqual([]);
    expect((await billByIdentifier("SB 5")).status).toBe("passed_chamber");
    expect((await billByIdentifier("HR 10")).identifier).toBe("HR 10");
  });

  it("maps committees, sponsors, undated votes and hearing times as the manual defines them", async () => {
    const db = await systemDb();
    const hb = await billByIdentifier("HB 1");
    expect(hb.status).toBe("in_committee");
    const [c] = await db.select({ name: committees.name }).from(billCommitteeLinks).innerJoin(committees, eq(committees.id, billCommitteeLinks.committeeId))
      .where(eq(billCommitteeLinks.billId, hb.id));
    expect(c.name).toBe("Education");
    const sponsors = await db.select().from(billSponsors).where(eq(billSponsors.billId, hb.id)).orderBy(billSponsors.sequence);
    expect(sponsors.map((s) => [s.name, s.sponsorType])).toEqual([
      ["Pat Example", "primary"],
      ["Lee Sample", "cosponsor"],
    ]);
    const [vote] = await db.select().from(rollCalls).where(eq(rollCalls.billId, hb.id));
    expect(vote.voteDate).toBeNull();
    expect(vote.yes).toBe(150);
    const events = await db.select().from(legislativeEvents).orderBy(legislativeEvents.startsAt);
    // An untimed hearing at noon EST, and 1 PM EDT on 2026-03-19.
    expect(events.map((e) => e.startsAt.toISOString())).toEqual(["2026-01-20T17:00:00.000Z", "2026-03-19T17:00:00.000Z"]);
  });

  it("an unchanged master list costs two queries and fetches no bills", async () => {
    fake.ops = [];
    const provider = new LegiScanProvider({ apiKey: "test-key" });
    const r = await syncJurisdiction("GA", { provider, sessionIdentifiers: ["2025-2026"] });
    expect(fake.ops).toEqual(["getSessionList", "getMasterListRaw"]);
    expect(r.billsChanged).toBe(0);
  });

  it("a changed hash on a stored bill fetches it and reports its new action for alerts", async () => {
    fake.ops = [];
    fake.masterlist["9001"] = "a2";
    fake.current["9001"] = { ...hb1, change_hash: "a2",
      history: [...(hb1.history as Json[]), { date: "2025-02-03", action: "House Committee Favorably Reported", chamber: "H", chamber_id: 1, importance: 1 }] };
    const r = await syncJurisdiction("GA", { provider: new LegiScanProvider({ apiKey: "test-key" }), sessionIdentifiers: ["2025-2026"] });
    expect(fake.ops).toEqual(["getSessionList", "getMasterListRaw", "getBill:9001"]);
    expect(r.newActionIds).toHaveLength(1);
  });

  it("decodes base64 bill text and surfaces API errors with LegiScan's message", async () => {
    const provider = new LegiScanProvider({ apiKey: "test-key" });
    expect(await provider.getVersionText("GA", { providerVersionId: "7001" })).toContain("Section 1. Synthetic text.");
    await expect(new LegiScanProvider({ apiKey: "wrong" }).listSessions("GA")).rejects.toThrow("Invalid API key");
  });
});

describe("LegiScan adapter without dataset access", () => {
  const fake = new FakeLegiScan();
  beforeAll(async () => {
    await freshDatabase();
    fake.datasetAvailable = false;
    setProviderFetchForTests(fake.fetch);
  });
  afterAll(() => setProviderFetchForTests(null));

  it("falls back to one getBill per bill and still completes", async () => {
    const r = await syncJurisdiction("GA", { provider: new LegiScanProvider({ apiKey: "test-key" }), sessionIdentifiers: ["2025-2026"] });
    expect(r.status).toBe("succeeded");
    expect(r.bulkLoaded).toBe(0);
    expect(fake.ops).toEqual(["getSessionList", "getSessionPeople", "getDatasetList", "getMasterListRaw", "getBill:9001", "getBill:9002", "getBill:9003"]);
    expect(r.billsChanged).toBe(3);
  });
});

describe("localTimeToIso", () => {
  it("converts wall-clock times across daylight-saving changes", () => {
    expect(localTimeToIso("2026-03-07", "09:30", "America/New_York")).toBe("2026-03-07T14:30:00.000Z");
    expect(localTimeToIso("2026-03-09", "09:30", "America/New_York")).toBe("2026-03-09T13:30:00.000Z");
    expect(localTimeToIso("0000-00-00", "09:30", "America/New_York")).toBeNull();
  });
});
