import { describe, expect, it } from "vitest";
import { runPipeline, type PipelineDeps } from "@/server/classification/pipeline";
import { flattenTaxonomy } from "@/server/classification/default-taxonomy";
import { extractBillMentions, numberFromWords, sessionsInScope, type BillCandidate } from "@/server/classification/bills";
import { numberCloseness, type SessionBill } from "@/server/classification/bill-matching";

const SESSION = { sessionIdentifier: "2025-2026", sessionStart: "2025-01-13", sessionEnd: "2026-04-30", jurisdictionCode: "ZZ" };
const bill = (n: number, identifier: string, title: string, subjects: string[],
  sponsorNames: string[] = []): BillCandidate => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier, ...SESSION, title, subjects,
  sponsorNames });
const bills = [
  bill(1, "HB 142", "School Funding Formula Revision Act", ["Education"], ["Dana Whitfield"]),
  bill(2, "SB 40", "Speed Camera Expansion in School Zones", ["Transportation"]),
  bill(3, "SB 41", "School Zone Speed Camera Repeal", ["Transportation"]),
  bill(4, "HB 124", "Commercial Fishing License Fees", ["Natural Resources"]),
  bill(5, "HB 77", "Rural Hospital Tax Credit", ["Health"]),
  bill(6, "HB 5001", "An Act Concerning Unemployment for Striking Workers", ["Labor"]),
  bill(7, "SB 300", "Road Maintenance Funding Formula", ["Transportation"]),
  bill(8, "HB 300", "Road Maintenance Funding Formula", ["Transportation"]),
  bill(9, "HB 5338", "An Act Concerning Service Providers for the Federal Lifeline Benefits", ["Utilities"]),
];
const session: SessionBill[] = bills.map((b) => ({ id: b.id, identifier: b.identifier, billType: b.identifier.split(" ")[0],
  number: Number(b.identifier.split(" ")[1]), title: b.title, sessionIdentifier: b.sessionIdentifier }));

const deps: PipelineDeps = {
  taxonomy: flattenTaxonomy(),
  officeJurisdiction: "ZZ",
  office: { internalDomains: [], legislatureDomains: [], agencies: [] },
  thresholds: { issue: 0.85, position: 0.9, billMatch: 0.95, messageType: 0.8 },
  findBillCandidates: async (refs) => bills.filter((b) => refs.includes(b.identifier)),
  sessionScope: async () => ({ bills: session, sessions: ["2025-2026"] }),
  ai: null,
};
const run = (body: string, subject = "") =>
  runPipeline({ envelope: { fromAddress: "pat@gmail.com", fromName: "Pat", subject, headers: {}, labels: [], direction: "inbound",
    sentAt: new Date("2026-02-10T15:00:00Z") }, bodyText: body, bodyHtml: null }, deps).then((r) => r.result);
const only = (r: Awaited<ReturnType<typeof run>>) => {
  expect(r.bill_references).toHaveLength(1);
  return r.bill_references[0];
};

describe("how people write bill numbers", () => {
  it.each(["HB142", "HB 142", "H.B. 142", "H.B.142", "HB-142", "hb 142", "hb142", "HB #142", "HB No. 142", "House Bill 142", "house bill #142",
    "House Bill No. 142", "Hosue Bill 142", "HB 0142"])("reads %s", (written) => {
    expect(extractBillMentions(`Please look at ${written} today.`, "").map((m) => m.reference)).toEqual(["HB 142"]);
  });
  it("reads Connecticut's own forms", () => {
    expect(extractBillMentions("I support sHB 5001.", "")[0].reference).toBe("HB 5001");
    expect(extractBillMentions("HJ 78 passed.", "")[0].reference).toBe("HJ 78");
    expect(extractBillMentions("Raised Bill 5,001 is wrong.", "")[0].reference).toBe("Bill 5001");
  });
  it("leaves pounds, hours and invoices alone", () => {
    expect(extractBillMentions("It weighs lb 40 and took hr 12. My electric bill 142 was late. A bill of 85 dollars.", "")).toHaveLength(0);
  });
  it.each([["one forty-two", 142], ["three eighty-eight", 388], ["one oh five", 105], ["three hundred and ten", 310], ["Three Hundred Ten", 310], ["forty", 40],
    ["ninety-nine", 99], ["twelve", 12], ["fifteen hundred", 1500], ["five thousand one", 5001]])("reads the number in %s", (words, number) => {
    expect(numberFromWords(words)).toBe(number);
  });
  it("reads a bill number written in words", () => {
    expect(extractBillMentions("Please vote yes on House Bill one forty-two.", "").map((m) => m.reference)).toEqual(["HB 142"]);
    expect(extractBillMentions("I am writing about Senate Bill number forty.", "").map((m) => m.reference)).toEqual(["SB 40"]);
    expect(extractBillMentions("House Bill Three Hundred Ten would take our road money.", "").map((m) => m.reference)).toEqual(["HB 310"]);
  });
  it("leaves ordinary talk after the word bill alone", () => {
    const talk = "There was a House bill one of my neighbors told me about. I wrote about a Senate bill two years ago. The House bill ten of us testified on died.";
    expect(extractBillMentions(talk, "")).toHaveLength(0);
  });
  it("links a lone number word only when the letter backs it up", async () => {
    const lone = only(await run("Please look at Senate Bill forty."));
    expect(lone.reference).toBe("SB 40");
    expect(lone.confidence).toBeLessThan(0.95);
    const backed = only(await run("Please vote no on Senate Bill forty. Speed cameras in school zones only raise money."));
    expect(backed.reference).toBe("SB 40");
    expect(backed.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

describe("a bill called by name", () => {
  it("tags any bill in session from its full title", async () => {
    const b = only(await run("Please oppose the Commercial Fishing License Fees proposal."));
    expect(b).toMatchObject({ reference: "HB 124", resolution_status: "resolved", bill_id: bills[3].id });
    expect(b.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it("carries the writer's stance to the bill they named", async () => {
    const r = await run("I strongly oppose the Commercial Fishing License Fees bill.");
    expect(r.positions.find((p) => p.bill_reference === "HB 124")?.position).toBe("oppose");
  });
  it("takes part of a name when the writer says it is a bill", async () => {
    expect(only(await run("Vote yes on the School Funding Formula bill."))).toMatchObject({ reference: "HB 142", resolution_status: "resolved" });
    expect(only(await run("Please stop the bill on unemployment for striking workers.")))
      .toMatchObject({ reference: "HB 5001", resolution_status: "resolved" });
  });
  it("copes with a misspelled name", async () => {
    expect(only(await run("Please pass the Comercial Fishing Licence Fees bill."))).toMatchObject({ reference: "HB 124", resolution_status: "resolved" });
  });
  it("reads a name in the subject line", async () => {
    expect(only(await run("Please help.", "Rural Hospital Tax Credit"))).toMatchObject({ reference: "HB 77", resolution_status: "resolved" });
  });
  it("asks staff when two bills share the name", async () => {
    const b = only(await run("Please pass the Road Maintenance Funding Formula."));
    expect(b.resolution_status).toBe("ambiguous");
    expect(b.bill_id).toBeNull();
    expect(b.candidate_bill_ids).toHaveLength(2);
  });
  it("does not tag ordinary talk about a topic", async () => {
    for (const body of ["School funding matters to my family.", "My road needs maintenance.", "The hospital in our town is closing.",
      "I care about speed in school zones.", "My unemployment claim is stuck and workers are waiting."]) {
      expect((await run(body)).bill_references, body).toHaveLength(0);
    }
  });
  it("ignores another state's bill of the same name", async () => {
    expect((await run("Ohio's Commercial Fishing License Fees bill is a mess.")).bill_references).toHaveLength(0);
  });
  it("is not thrown by the word Federal inside a state bill's own title", async () => {
    expect(only(await run("Please support An Act Concerning Service Providers for the Federal Lifeline Benefits.")))
      .toMatchObject({ reference: "HB 5338", resolution_status: "resolved" });
  });
  it("skips the same title when the sentence is about Congress", async () => {
    expect((await run("Congress should pass the Commercial Fishing License Fees bill.")).bill_references).toHaveLength(0);
  });
  it("counts a number and a name for the same bill once", async () => {
    const b = only(await run("Please support HB 142, the School Funding Formula Revision Act."));
    expect(b).toMatchObject({ reference: "HB 142", resolution_status: "resolved" });
    expect(b.evidence.length).toBeGreaterThanOrEqual(2);
  });
  it("also tags what the bill is about", async () => {
    const r = await run("Please vote yes on HB 142. The formula needs revision.");
    expect(r.issues.map((i) => i.taxonomy_id)).toContain("education.school_funding");
    expect(r.positions.filter((p) => p.target_type === "issue")).toHaveLength(0);
  });
});

describe("a mistyped number", () => {
  it("fixes swapped digits when the message says what the bill is", async () => {
    const b = only(await run("Please vote yes on HB 412. The school funding formula is out of date and needs revision."));
    expect(b).toMatchObject({ raw_reference: "HB 412", reference: "HB 142", resolution_status: "resolved", bill_id: bills[0].id });
    expect(b.confidence).toBeGreaterThanOrEqual(0.95);
  });
  it("moves the stance to the corrected bill", async () => {
    const r = await run("I oppose HB 412. The school funding formula is out of date and needs revision.");
    expect(r.positions.find((p) => p.target_type === "bill")?.bill_reference).toBe("HB 142");
  });
  it("fixes a wrong chamber", async () => {
    expect(only(await run("Please support SB 5001 on unemployment for striking workers.")))
      .toMatchObject({ reference: "HB 5001", resolution_status: "resolved" });
  });
  it("fixes a dropped digit", async () => {
    expect(only(await run("Please support HB 14. We need a new school funding formula revision.")))
      .toMatchObject({ reference: "HB 142", resolution_status: "resolved" });
  });
  it("reads the usual opening of a letter as a stance", async () => {
    const r = await run("I am writing to support HB 412. The school funding formula is out of date and needs revision.");
    expect(r.positions.find((p) => p.target_type === "bill")).toMatchObject({ bill_reference: "HB 142", position: "support" });
  });
  it("trusts the name over a number that belongs to something else", async () => {
    const b = only(await run("Please support HB 124, the School Funding Formula Revision Act."));
    expect(b).toMatchObject({ reference: "HB 142", raw_reference: "HB 124", resolution_status: "resolved" });
  });
  it("asks when a real number does not fit what the message says", async () => {
    const b = only(await run("Please support HB 124. The school funding formula is out of date and needs revision."));
    expect(b.resolution_status).toBe("ambiguous");
    expect(b.bill_id).toBeNull();
    expect(b.candidate_bill_ids).toEqual([bills[0].id, bills[3].id]);
  });
  it("offers the likely bill but does not guess when the message gives no clue", async () => {
    const b = only(await run("What is happening with HB 412?"));
    expect(b.resolution_status).toBe("ambiguous");
    expect(b.bill_id).toBeNull();
    expect(b.candidate_bill_ids).toContain(bills[0].id);
  });
  it("leaves a right number alone", async () => {
    expect(only(await run("Please vote yes on HB 142. The school funding formula is out of date.")))
      .toMatchObject({ reference: "HB 142", raw_reference: "HB 142", resolution_status: "resolved" });
  });
  it("finds a number written with no chamber", async () => {
    expect(only(await run("Bill 5001 on striking workers is a mistake."))).toMatchObject({ reference: "HB 5001", resolution_status: "resolved" });
  });
  it("never corrects a bill from another state", async () => {
    expect(only(await run("Texas HB 412 on school funding formula revision is a disaster.")).resolution_status).toBe("out_of_jurisdiction");
  });
  it("measures closeness the way typos happen", () => {
    const hb = (number: number) => ({ billType: "HB", number });
    expect(numberCloseness({ billType: "HB", number: 412 }, hb(142))).toBe(1);
    expect(numberCloseness({ billType: "HB", number: 143 }, hb(142))).toBe(2);
    expect(numberCloseness({ billType: "HB", number: 14 }, hb(142))).toBe(3);
    expect(numberCloseness({ billType: "SB", number: 142 }, hb(142))).toBe(1);
    expect(numberCloseness({ billType: "HB", number: 900 }, hb(142))).toBeNull();
  });
});

describe("which session a message can be about", () => {
  const sessions = [{ id: "a", startDate: "2023-01-09", endDate: "2024-04-01" }, { id: "b", startDate: "2026-02-04", endDate: "2026-05-06" }];
  it("uses the session underway", () => expect(sessionsInScope(sessions, new Date("2026-03-01")).map((s) => s.id)).toEqual(["b"]));
  it("uses the latest session between sessions", () => expect(sessionsInScope(sessions, new Date("2026-11-09")).map((s) => s.id)).toEqual(["b"]));
});
