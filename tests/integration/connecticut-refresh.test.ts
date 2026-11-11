import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../helpers/db";

const fetched: string[] = [];
const published = new Set<string>();

vi.mock("@/server/legislation/connecticut-fetch", () => ({
  fetchFromCga: async (url: string) => {
    fetched.push(url);
    const there = published.has(url);
    return { ok: there, status: there ? 200 : 404, contentType: there ? "application/pdf" : "text/html", bytes: new Uint8Array([1]) };
  },
  listFtpFolder: async () => [],
  pdfToLayoutText: async () => "not an analysis",
  pdfToXml: async () => NOTE,
}));
vi.mock("@/server/legislation/text", () => ({ extractDocumentText: async () => "Bill text", htmlToText: (s: string) => s }));

import { buildConnecticutSession, type CtSource, type StoredDocument } from "@/server/legislation/connecticut-build";
import { parseFiscalNote } from "@/server/legislation/connecticut-fiscal";
import { systemDb } from "@/server/db/client";
import { legislativeSourceSyncs } from "@/server/db/schema";
import { FixtureProvider, registerFixtureProvider } from "@/server/legislation/providers/fixture";
import { demoLegislativeDataset } from "@/server/demo/legislative-fixture";
import { handleLegislativeSync, syncJurisdiction } from "@/server/legislation/sync";

// A text run as pdftohtml writes it; font sizes are in the fontspec lines.
const t = (top: number, left: number, width: number, text: string,
  font = 1) => `<text top="${top}" left="${left}" width="${width}" height="20" font="${font}">${text}</text>`;
const page = (...runs: string[]) => `<page number="1" position="absolute" top="0" left="0" height="1188" width="918">\n${runs.join("\n")}\n</page>`;
const fonts = `<fontspec id="1" size="18" family="A" color="#000"/><fontspec id="2" size="12" family="A" color="#000"/>`;

const header = (top: number) => [t(top, 251, 118, "Agency Affected "), t(top, 454, 85, "Fund-Effect "), t(top, 586, 52, "FY 27 $ "),
  t(top, 683, 52, "FY 28 $ ")];

const NOTE =
  fonts +
  page(
    t(160, 189, 58, "SB-484 "),
    t(249, 316, 318, 'As Amended by Senate &#34;A&#34; (LCO 4908), House &#34;B&#34; (LCO 11) '),
    t(388, 189, 144, "<i><b>OFA Fiscal Note </b></i>"),
    t(431, 189, 118, "<i><b>State Impact: </b></i>"),
    ...header(464),
    // A cost wrapping onto a second line, the name wrapping beside it.
    t(483, 197, 120, "Secretary of the "),
    t(483, 435, 66, "GF - Cost "),
    t(483, 586, 52, "612,000 to "),
    t(483, 683, 52, "341,000 to "),
    t(502, 197, 50, "State "),
    t(502, 586, 52, "753,000 "),
    t(502, 683, 52, "459,000 "),
    // An effect that wraps, its amount starting a line early.
    t(521, 197, 138, "Public Health, Dept. "),
    t(521, 435, 94, "GF - Revenue "),
    t(521, 580, 63, "Potential "),
    t(521, 678, 63, "Potential "),
    t(540, 435, 36, "Gain "),
    t(540, 582, 61, "Minimal "),
    t(540, 679, 61, "Minimal "),
    // Two cells close enough to come back as one run.
    t(559, 197, 300, "Soldiers, Sailors  SF - Cost "),
    t(559, 571, 178, "17.4 million  23.8 million "),
    t(578, 189, 378, "Note: GF=General Fund; SF=Special Fund"),
    t(603, 189, 152, "<i><b>Municipal Impact:</b></i>"),
    t(603, 341, 48, " None"),
    t(637, 189, 107, "<i><b>Explanation </b></i>"),
    t(676, 211, 300, "The bill costs less than $<a>600</a>"),
    t(677, 511, 6, "<a>2</a>", 2),
    t(676, 517, 200, " each year. "),
    t(702, 189, 300, "It continues into the session. The table below shows why. "),
    t(904, 189, 5, "2", 2),
    t(903, 194, 400, " A footnote that must not be read as body text. "),
    t(1052, 197, 140, "Primary Analyst: RP "),
  ) +
  page(t(82, 189, 400, "2026SB-00484-R01-FN.DOCX    Page 2 of 2"), t(120, 189, 200, "<i><b>The Out Years</b></i>"), t(150, 211, 300, "The cost continues. "),
    t(300, 189, 300, "The preceding Fiscal Impact statement is prepared for the benefit of members."));

describe("Connecticut fiscal notes", () => {
  const note = parseFiscalNote(NOTE)!;

  it("reads a footnote mark as a mark, never as part of a dollar amount", () => {
    expect(note.explanation[0]).toBe("The bill costs less than $600 each year. It continues into the session.");
    expect(JSON.stringify(note)).not.toContain("footnote");
  });

  it("keeps a table row together when its cells wrap", () => {
    expect(note.state.years).toEqual(["FY 27", "FY 28"]);
    expect(note.state.lines[0])
      .toEqual({ who: "Secretary of the State", effect: "General Fund, cost", amounts: ["$612,000 to $753,000", "$341,000 to $459,000"] });
    expect(note.state.lines[1])
      .toEqual({ who: "Public Health, Dept.", effect: "General Fund, revenue gain", amounts: ["Potential Minimal", "Potential Minimal"] });
  });

  it("separates cells the PDF reader ran together", () => {
    expect(note.state.lines[2]).toEqual({ who: "Soldiers, Sailors", effect: "Special Fund, cost", amounts: ["$17.4 million", "$23.8 million"] });
  });

  it("takes the note's own word when there is no table, and what it says about later years", () => {
    expect(note.municipal).toEqual({ said: "None", years: [], lines: [] });
    expect(note.later).toBe("The cost continues.");
    expect(note.describes).toBe('As amended by Senate "A", House "B"');
  });
});

const BASE = "https://www.cga.ct.gov/2026";
const NOTE_URL = `${BASE}/FN/PDF/2026SB-00484-R000033-FN.PDF`;
const FILE_COPY_URL = `${BASE}/FC/PDF/2026SB-00484-R000033-FC.PDF`;

const csvs = (year: string, actions: [string, string, string][]) => ({
  bill_info: `bill_num,sess_year,type_code,bill_title,stmt_purp\nSB00484,${year},RB,AN ACT,To do it\n`,
  bill_history: `sess_year,bill_num,act_desc,act_date,qual1,qual2,sort_order\n${actions.map(([d, q, o]) => `${year},SB00484,${d},2026-03-${o} 00:00:00,${q},,${o}`).join("\n")}\n`,
  introducer: `bill_num,intro_code,intro_type,sort_order\nSB00484,TRA,I,1\n`,
  subject: `bill_num,subj_desc\nSB00484,Roads\n`,
  committee: `comm_code,comm_name\nTRA,Transportation Committee\n`,
  LegislatorDatabase: `office code,dist,commonly used name,first name,last name,suffix,party,committee member1,title,email,capitol phone,room number,capitol street address\nH,119,Kathy,Kathy,Kennedy,,R,,,,,,\n`,
});

function memorySource(files: Record<string, string>) {
  const held = new Map<string, StoredDocument>();
  const source: CtSource = {
    csv: async (name) => files[name],
    listFolder: async () => [],
    read: async (url) => held.get(url) ?? null,
    write: async (url, found, body) => void held.set(url, { found, body, checkedAt: new Date() }),
  };
  return { source, held };
}

describe("Connecticut refresh", () => {
  const FILED: [string, string, string] = ["FILE NO.", "33", "10"];

  it("reads each document once, then asks the state for nothing new", async () => {
    published.clear();
    published.add(FILE_COPY_URL).add(NOTE_URL);
    fetched.length = 0;
    const { source } = memorySource(csvs("2026", [FILED]));
    const first = await buildConnecticutSession(source);
    expect(first.snapshot.bills[0].fiscal?.url).toBe(NOTE_URL);
    expect(first.snapshot.bills[0].fiscal?.describes).toBe('As amended by Senate "A", House "B"');
    fetched.length = 0;
    const second = await buildConnecticutSession(source);
    expect(fetched).toEqual([]);
    expect(second.snapshot.bills[0].changeHash).toBe(first.snapshot.bills[0].changeHash);
  });

  it("looks again for a missing document in the week after a new action, and not otherwise", async () => {
    published.clear();
    published.add(FILE_COPY_URL);
    fetched.length = 0;
    const { source, held } = memorySource(csvs("2026", [FILED]));
    await buildConnecticutSession(source);
    expect(held.get(NOTE_URL)?.found).toBe(false);

    // Checked over a week after the last action: it stays settled.
    held.set(NOTE_URL, { found: false, body: null, checkedAt: new Date("2026-04-01") });
    fetched.length = 0;
    await buildConnecticutSession(source);
    expect(fetched).not.toContain(NOTE_URL);

    // Checked the day after the action: the state may still post it.
    held.set(NOTE_URL, { found: false, body: null, checkedAt: new Date("2026-03-11") });
    published.add(NOTE_URL);
    const { snapshot } = await buildConnecticutSession(source);
    expect(snapshot.bills[0].fiscal?.url).toBe(NOTE_URL);
  });

  it("refuses to file the next session's bills under this session", async () => {
    const { source } = memorySource(csvs("2027", [FILED]));
    await expect(buildConnecticutSession(source)).rejects.toThrow(/no 2026 bills/);
  });
});

describe("a sync when nothing has changed at the source", () => {
  const provider = new FixtureProvider(demoLegislativeDataset());
  const calls: boolean[] = [];

  beforeAll(async () => {
    await freshDatabase();
    Object.assign(provider, { hasNews: async () => false, finished: async (c: boolean) => void calls.push(c) });
  });

  it("records the check and stops there", async () => {
    const listed = vi.spyOn(provider, "listSessions");
    const r = await syncJurisdiction("ZZ", { provider });
    expect(r).toMatchObject({ status: "succeeded", billsChanged: 0 });
    expect(listed).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("records nothing when a sync is already running, so the site does not claim a check that did not happen", async () => {
    const db = await systemDb();
    const before = (await db.select().from(legislativeSourceSyncs)).length;
    Object.assign(provider, { isBusy: () => true });
    registerFixtureProvider(provider);
    const r = await handleLegislativeSync({ jurisdiction: "ZZ" });
    expect(r).toEqual({ skipped: "A sync is already running" });
    expect((await db.select().from(legislativeSourceSyncs)).length).toBe(before);
  });

  afterAll(() => registerFixtureProvider(null));
});
