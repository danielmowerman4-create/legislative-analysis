import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "@/server/classification/pipeline";
import { flattenTaxonomy } from "@/server/classification/default-taxonomy";
import { htmlToText, preprocess } from "@/server/classification/preprocess";
import { sponsorNamed, type BillCandidate } from "@/server/classification/bills";

const SESSION = { sessionIdentifier: "2025-2026", sessionStart: "2025-01-13", sessionEnd: "2026-04-30" };
const bills: BillCandidate[] = [
  { id: "00000000-0000-4000-8000-000000000142", identifier: "HB 142", jurisdictionCode: "ZZ", ...SESSION, title: "School Funding Formula Revision Act",
    subjects: ["Education"], sponsorNames: ["Dana Whitfield"] },
  { id: "00000000-0000-4000-8000-000000000040", identifier: "SB 40", jurisdictionCode: "ZZ", ...SESSION, title: "Speed Camera Expansion in School Zones",
    subjects: ["Transportation"], sponsorNames: ["Lee Ortiz"] },
  { id: "00000000-0000-4000-8000-000000000077", identifier: "HB 77", jurisdictionCode: "ZZ", ...SESSION, title: "Rural Hospital Tax Credit",
    subjects: ["Health"], sponsorNames: ["Sam Reyes"] },
  { id: "00000000-0000-4000-8000-000000000078", identifier: "HB 77", jurisdictionCode: "ZZ", sessionIdentifier: "2025 Special", sessionStart: "2025-06-01",
    sessionEnd: "2025-12-31", title: "Special Session Redistricting", subjects: ["Elections"], sponsorNames: [] },
];

const deps: PipelineDeps = {
  taxonomy: flattenTaxonomy(),
  officeJurisdiction: "ZZ",
  office: { internalDomains: ["house.example.gov"], legislatureDomains: ["legis.example.gov"],
    agencies: [{ name: "Demo State Department of Labor", abbreviation: "DSDOL", domains: ["labor.demo.gov"] }] },
  thresholds: { issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 },
  findBillCandidates: async (refs) => bills.filter((b) => refs.includes(b.identifier)),
  ai: null,
};

const run = (body: string,
  opts: Partial<{ subject: string; from: string; headers: Record<string, string>; direction: "inbound" | "outbound"; sentAt: Date }> = {}) =>
  runPipeline(
    {
      envelope: {
        fromAddress: opts.from ?? "pat.jones@gmail.com",
        fromName: "Pat Jones",
        subject: opts.subject ?? "",
        headers: opts.headers ?? {},
        labels: [],
        direction: opts.direction ?? "inbound",
        sentAt: opts.sentAt ?? new Date("2026-02-10T15:00:00Z"),
      },
      bodyText: body,
      bodyHtml: null,
    },
    deps,
  ).then((r) => r.result);

describe("classification pipeline", () => {
  it("keeps two opposite bill positions in one email (Test C)", async () => {
    const r = await run("Dear Representative,\n\nI support HB 142 because our schools need the new funding formula, but I oppose SB 40. Speed cameras near schools are a money grab.\n\nThanks,\nPat");
    const hb = r.positions.find((p) => p.bill_reference === "HB 142")!;
    const sb = r.positions.find((p) => p.bill_reference === "SB 40")!;
    expect(hb.position).toBe("support");
    expect(sb.position).toBe("oppose");
    expect(hb.evidence[0].text).toMatch(/support HB 142/);
    expect(sb.evidence[0].text).toMatch(/oppose SB 40/);
  });

  it("resolves a corroborated bill and flags an ambiguous number instead of guessing (Test B)", async () => {
    const r = await run("Please vote yes on HB 142. The school funding formula is decades out of date.");
    const hb = r.bill_references.find((b) => b.reference === "HB 142")!;
    expect(hb.resolution_status).toBe("resolved");
    expect(hb.bill_id).toBe(bills[0].id);
    expect(hb.confidence).toBeGreaterThanOrEqual(0.95);

    const amb = await run("I want to know where you stand on HB 77.", { sentAt: new Date("2025-09-01T12:00:00Z") });
    const b = amb.bill_references[0];
    expect(b.resolution_status).toBe("ambiguous");
    expect(b.bill_id).toBeNull();
    expect(b.candidate_bill_ids).toHaveLength(2);
    expect(amb.requires_staff_review).toBe(true);
  });

  it("never links an out-of-state or federal bill", async () => {
    const tx = await run("Texas HB 142 is a disaster and I hope nobody copies it here.");
    expect(tx.bill_references[0].resolution_status).toBe("out_of_jurisdiction");
    expect(tx.bill_references[0].bill_id).toBeNull();
    const fed = await run("Please ask our congressman to oppose H.R. 142 in Congress.");
    expect(fed.bill_references[0].resolution_status).toBe("out_of_jurisdiction");
  });

  it("does not take quoted or reported arguments as the sender's position", async () => {
    const r = await run('Supporters say HB 142 will "fix school funding once and for all." I am not convinced. What does the bill actually change for our district?');
    const hb = r.positions.find((p) => p.bill_reference === "HB 142")!;
    expect(["neutral", "unclear"]).toContain(hb.position);
  });

  it("ignores forwarded content for positions", async () => {
    const r = await run("FYI\n\n---------- Forwarded message ---------\nFrom: Advocacy Group <news@group.org>\nSubject: Act now\n\nI strongly oppose HB 142. Tell your rep to vote no!");
    expect(r.positions.every((p) => p.position !== "oppose")).toBe(true);
    const pre = preprocess({ bodyText: "Thoughts?\n\n---------- Forwarded message ---------\nI oppose HB 142" });
    expect(pre.substantive).toBe("Thoughts?");
    expect(pre.forwarded).toContain("oppose HB 142");
  });

  it("strips quoted replies", () => {
    const pre = preprocess({ bodyText: "Thank you, that helps.\n\nOn Mon, Feb 9, 2026 at 3:12 PM Office of Rep. Test <rep@house.example.gov> wrote:\n> We oppose nothing.\n> Regards" });
    expect(pre.substantive).toBe("Thank you, that helps.");
    expect(pre.quoted).toContain("We oppose nothing");
  });

  it("reads conditional support as mixed and sarcasm as unclear", async () => {
    const c = await run("I would support HB 142 only if it is amended to protect rural districts.");
    expect(c.positions.find((p) => p.bill_reference === "HB 142")!.position).toBe("mixed");
    const s = await run("Oh great, SB 40. Just what we need, more cameras taking our money.");
    expect(s.positions.find((p) => p.bill_reference === "SB 40")!.position).toBe("unclear");
  });

  it("detects a service request, case suggestion and sensitive content", async () => {
    const r = await run("I filed my unemployment claim with the Demo State Department of Labor in December and have still not received anything. I can't get through on the phone. My son has a medical diagnosis and we need the money. Can you help?");
    expect(r.message_type[0].type).toBe("constituent_service");
    expect(r.case_suggestion?.category).toBe("Unemployment insurance");
    expect(r.case_suggestion?.agency).toBe("Demo State Department of Labor");
    expect(r.sensitive.flagged).toBe(true);
    expect(r.requested_actions).toContain("agency_assistance");
  });

  it("marks newsletters and internal mail as non-correspondence with no positions", async () => {
    const n = await run("This week in transit policy: we support HB 142!",
      { from: "news@advocacy.org", headers: { "List-Unsubscribe": "<mailto:x@y>", "List-Id": "news.advocacy.org" } });
    expect(n.message_type[0].type).toBe("newsletter_automated");
    expect(n.positions).toHaveLength(0);
    const i = await run("Can you pull the HB 142 file?", { from: "aide@house.example.gov" });
    expect(i.message_type[0].type).toBe("legislative_staff");
  });

  it("extracts staff commitments from outgoing mail", async () => {
    const r = await run("Thanks for the details. I will contact the Department of Labor on Tuesday and follow up with you after.",
      { direction: "outbound", from: "aide@house.example.gov", sentAt: new Date("2026-02-12T15:00:00Z") });
    expect(r.commitments.length).toBeGreaterThan(0);
    expect(r.commitments[0].due_hint).not.toBeNull();
  });

  it("tags issues from the controlled taxonomy with evidence that matches the text", async () => {
    const r = await run("Teacher pay in our county is far behind neighboring states, and the potholes on Route 9 are getting worse.");
    const keys = r.issues.map((i) => i.taxonomy_id);
    expect(keys).toContain("education.teacher_pay");
    expect(keys).toContain("transportation.road_maintenance");
    for (const i of r.issues) for (const e of i.evidence) expect(e.text.length).toBeGreaterThan(0);
  });

  it("reads a letter whose HTML holds an impossible character code", () => {
    expect(htmlToText("<p>A&#99999999;B &#X41;&#39;&#x2019;&#0;</p>")).toBe("A&#99999999;B A'’&#0;");
  });

  it("matches a sponsor's name literally, whatever characters it holds", () => {
    expect(sponsorNamed(["Dana O(Neil"], "a letter about roads")).toBeUndefined();
    expect(sponsorNamed(["Rep. Sam Ortiz"], "i back the ortiz bill")).toBe("ortiz");
  });
});
