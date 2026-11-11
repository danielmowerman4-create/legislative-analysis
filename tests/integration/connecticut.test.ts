import { describe, expect, it } from "vitest";
import { cleanBillText, ctOutcome, titleCase, translateAction, undoReconsidered, type CtAction } from "@/server/legislation/connecticut";
import { floorAddsUp, nameFloorVotes, parseFloorVote, parseTally, tallyAddsUp, type FloorVote } from "@/server/legislation/connecticut-votes";
import { isPassageVote, isVoiceVote } from "@/server/legislation/scoring";
import { documentNames, parseAnalysis } from "@/server/legislation/connecticut-analysis";
import { citationLabel, extractCodeSections, isSection } from "@/server/legislation/related";
import { billStages } from "@/server/legislation/stages";

const committee = (c: string) => ({ TRA: "Transportation Committee", APP: "Appropriations Committee" })[c] ?? c;
const t = (raw: string, q1 = "", q2 = "", prev: "lower" | "upper" | null = null) => translateAction(raw, q1, q2, committee, prev);
const action = (raw: string, q1 = "", q2 = "", prev: "lower" | "upper" | null = null): CtAction => ({ ...t(raw, q1, q2, prev), date: "2026-04-01", raw });

describe("Connecticut action phrases", () => {
  it("reads committee referrals and hearings", () => {
    expect(t("REF. TO JOINT COMM. ON", "TRA"))
      .toMatchObject({ description: "Referred to Transportation Committee", classification: ["referred"], known: true });
    expect(t("PUBLIC HEARING", "0313").description).toBe("Public hearing March 13");
  });

  it("names the chamber and amendments on passage", () => {
    expect(t("HOUSE PASSED, HOUSE AMEND. SCH.", "A,E"))
      .toMatchObject({ description: "House passed as amended by House Amendments A and E", chamber: "lower", classification: ["chamber_vote", "passed"] });
    expect(t("SEN. PASSED, HO. AMEND. SCH.", "A")).toMatchObject({ description: "Senate passed as amended by House Amendment A", chamber: "upper" });
    expect(t("SEN. REJ. SEN. AMEND. SCH.", "B", "6005"))
      .toMatchObject({ description: "Senate rejected Senate Amendment B (LCO 6005)", classification: ["amendment"] });
  });

  it("does not read 'passed temporarily' as passage", () => {
    expect(t("BILL PASSED TEMPORARILY", "", "", "lower").classification).toEqual(["other"]);
  });

  it("flags a phrase it has no rule for", () => {
    expect(t("SOMETHING NEW").known).toBe(false);
  });
});

describe("Connecticut titles", () => {
  it("keeps small words and acronyms in their place", () => {
    expect(titleCase("AN ACT CONCERNING THE DMV AND O'BRIEN'S FARM.")).toBe("An Act Concerning the DMV and O'Brien's Farm");
    expect(titleCase("AN ACT CONCERNING NON-PROFIT CHILDREN'S SERVICES.")).toBe("An Act Concerning Non-Profit Children's Services");
  });
});

describe("Connecticut outcomes", () => {
  it("treats a signed bill as law and names the act", () => {
    expect(ctOutcome("HB", "lower", [action("HOUSE PASSED"), action("SENATE PASSED"), action("PUBLIC ACT", "26-42"), action("SIGNED BY GOVERNOR")]))
      .toMatchObject({ status: "enacted", statusText: "Public Act 26-42", dead: false });
  });

  it("says how far a bill got before adjournment", () => {
    expect(ctOutcome("HB", "lower", [action("REF. TO JOINT COMM. ON", "TRA")]))
      .toMatchObject({ status: "failed", statusText: "No committee action", dead: true });
    expect(ctOutcome("HB", "lower", [action("REF. TO JOINT COMM. ON", "TRA"), action("PUBLIC HEARING", "0313")]).statusText)
      .toBe("Public hearing, no committee vote");
    expect(ctOutcome("HB", "lower", [action("HOUSE CALENDAR NUMBER", "9")]).statusText).toBe("On the calendar, no floor vote");
    expect(ctOutcome("SB", "upper", [action("SENATE PASSED")]).statusText).toBe("Passed the Senate, no House vote");
  });

  it("does not count a vote the chamber reconsidered", () => {
    const actions = undoReconsidered([action("HOUSE PASSED"), action("SEN. PASSED, HO. AMEND. SCH.", "A"), action("SENATE RECONSIDERED"),
      action("MATTER PASS RETAINED", "", "", "upper")]);
    expect(ctOutcome("HB", "lower", actions)).toMatchObject({ status: "failed", statusText: "Passed the House, Senate vote reconsidered", dead: true });
    const repassed = undoReconsidered([action("HOUSE PASSED"), action("SENATE PASSED"), action("SENATE RECONSIDERED"), action("SENATE PASSED")]);
    expect(ctOutcome("HB", "lower", repassed).status).toBe("passed_both");
  });

  it("adopts resolutions without calling them law", () => {
    expect(ctOutcome("HJ", "lower", [action("ADOPTED, HOUSE"), action("ADOPTED, SENATE")])).toMatchObject({ status: "passed_both", statusText: "Adopted" });
    expect(ctOutcome("HR", "lower", [action("ADOPTED, HOUSE")])).toMatchObject({ status: "passed_chamber", statusText: "Adopted" });
  });
});

describe("Connecticut bill text", () => {
  it("removes printed line numbers but keeps citations that end a line", () => {
    const text = cleanBillText(
      [
        "sHB5001 / File No. 725 1",
        "AN ACT CONCERNING ROADS.",
        "Be it enacted by the Senate and House of Representatives in General",
        "Assembly convened:",
        "Section 1. Section 9-135 of the general statutes is repealed and the1",
        "following is substituted in lieu thereof, as provided in section 9-22",
        "(a) Any elector may vote3",
        "by absentee ballot under section 9-1354",
        "of the statutes.5",
      ].join("\n"),
    );
    expect(text).not.toContain("File No. 725");
    expect(text).toContain("repealed and the following is substituted");
    expect(text).toContain("as provided in section 9-2\n\n(a) Any elector may vote by absentee ballot under section 9-135 of the statutes.");
  });
});

describe("Connecticut code citations", () => {
  it("takes sections a bill changes and leaves ones it only mentions", () => {
    const cites = extractCodeSections("Section 9-135 of the general statutes is repealed. As defined in section 12-81 of the general statutes, and subsection (a) of section 10-145d of the 2026 supplement to the general statutes is repealed.");
    expect(cites).toEqual(["cgs:9-135", "cgs:10-145d"]);
  });

  it("reads lists and proposed-bill wording", () => {
    expect(extractCodeSections("Sections 14-1 and 14-2 of the general statutes are repealed.")).toEqual(["cgs:14-1", "cgs:14-2"]);
    expect(extractCodeSections("That chapter 229 of the general statutes be amended to establish a credit.")).toEqual(["cgs:ch229"]);
  });

  it("labels them and leaves Georgia citations alone", () => {
    expect(citationLabel("cgs:14-297")).toBe("C.G.S. § 14-297");
    expect(citationLabel("cgs:ch229")).toBe("C.G.S. Chapter 229");
    expect(isSection("cgs:14-297")).toBe(true);
    expect(isSection("cgs:ch229")).toBe(false);
    expect(extractCodeSections("Code Section 20-2-161")).toEqual(["20-2", "20-2-161"]);
  });
});

describe("Joint committee stages", () => {
  const steps = (actions: { actionDate: string; chamber: string | null; classification: string[]; description: string }[], billType = "HB",
    status: Parameters<typeof billStages>[0]["status"] = "enacted") =>
    billStages({ chamber: "lower", billType, status, statusText: "No committee action" }, actions, { jointCommittees: true });
  it("has one committee stage before the first chamber", () => {
    expect(steps([]).stages.map((s) => s.label)).toEqual(["Introduced", "Committee", "Passed House", "Passed Senate", "Governor", "Law"]);
  });
  it("stops joint resolutions at adoption and states how a dead bill ended", () => {
    expect(steps([], "HJ", "passed_both").stages.map((s) => s.label)).toEqual(["Introduced", "Committee", "Adopted House", "Adopted Senate"]);
    expect(steps([], "HB", "failed").outcome).toMatchObject({ kind: "failed", label: "No committee action" });
  });
});

describe("Connecticut vote sheets", () => {
  const house = [
    "Vote for HB-5001 Roll Call Number 97",
    "Taken on 04/23 AS AMENDED",
    "",
    "     Total Number Voting ........... 4",
    "     Necessary for Passage ......... 3",
    "        Those voting Yea ........... 2",
    "        Those voting Nay ........... 1",
    "        Those absent and not voting  1",
    "",
    "     The following is the roll call vote:",
    "",
    " Y        JOHNSON, D.                   N        KAVROS DEGRAW                     X    STAFSTROM",
    " Y        MCGORTY, B.",
  ].join("\n");
  const senate = [
    "Vote for HB-5001 Sequence Number 362",
    "Taken on 5/6",
    "   Total Number Voting ........ 3",
    "   Necessary for Adoption ..... 2",
    "   Those voting Yea............ 1",
    "   Those voting Nay ........... 2",
    "   Those absent and not voting  0",
    "   The following is the roll call vote:",
    "     N 1 JOHN W. FONFARA                                                      N 19 CATHERINE A. OSTEN",
    "   Y   7 JOHN A. KISSEL",
  ].join("\n");
  const tally = [
    "                            TRANSPORTATION COMMITTEE",
    "                                            VOTE TALLY SHEET",
    "",
    "Bill No.:      HB05001            Amendment Letter:",
    "Action:      Joint Favorable Substitute",
    "                   Voting            Yea            Nay          Abstain             Absent and Not Voting",
    "TOTALS",
    "                      3              2             1               0                        0",
    "",
    "                                     yea      nay   abstain absent                                           yea   nay   abstain absent",
    "Sen. Flexer M. S29                    X                                  Rep. Kennedy K. 119                 X",
    "Rep. Morrin Bello A. 028                        X",
    "Vote date: 03/20/2026 10:15AM",
  ].join("\n");

  it("reads a House roll call and tells passage from amendment", () => {
    const v = parseFloorVote(house, "2026HV-00097-R00HB05001-HV.PDF")!;
    expect(v).toMatchObject({ chamber: "lower", number: 97, billNum: "HB05001", date: "2026-04-23", necessaryFor: "Passage", note: "AS AMENDED", yes: 2, no: 1,
      absent: 1 });
    expect(v.members).toEqual([
      { mark: "yes", name: "JOHNSON, D." },
      { mark: "no", name: "KAVROS DEGRAW" },
      { mark: "not_voting", name: "STAFSTROM" },
      { mark: "yes", name: "MCGORTY, B." },
    ]);
    expect(floorAddsUp(v)).toBe(true);
  });

  it("reads a Senate roll call by district", () => {
    const v = parseFloorVote(senate, "2026SV-00362-R00HB05001-SV.PDF")!;
    expect(v).toMatchObject({ chamber: "upper", number: 362, date: "2026-05-06", necessaryFor: "Adoption", yes: 1, no: 2 });
    expect(v.members.map((m) => [m.mark, m.district])).toEqual([["no", "1"], ["no", "19"], ["yes", "7"]]);
    expect(floorAddsUp(v)).toBe(true);
  });

  it("reads which column each committee member's mark is in", () => {
    const v = parseTally(tally, "2026HB-05001-R00TRA-CV127-TS.pdf")!;
    expect(v).toMatchObject({ committee: "TRA", number: 127, date: "2026-03-20", action: "Joint Favorable Substitute", amendment: null, yes: 2, no: 1 });
    expect(v.members.map((m) => [m.mark, m.district])).toEqual([["yes", "S29"], ["yes", "119"], ["no", "28"]]);
    expect(tallyAddsUp(v)).toBe(true);
  });

  it("reads a committee voice vote as passed, with no counts or names", () => {
    const sheet = tally.replace("                      3              2             1               0                        0",
      "                                                              Passed").replace(/^.*Sen\. Flexer.*$/m, "").replace(/^.*Morrin Bello.*$/m, "");
    const v = parseTally(sheet, "2026HB-05001-R00TRA-CV127-TS.pdf")!;
    expect(v).toMatchObject({ voice: "passed", yes: 0, no: 0, members: [] });
    expect(isVoiceVote(v)).toBe(true);
    expect(parseTally(tally, "2026HB-05001-R00TRA-CV127-TS.pdf")!.voice).toBeNull();
    expect(isVoiceVote({ yes: 0, no: 3, other: 1 })).toBe(false);
  });

  it("reads what a short bill does from its analysis, leaving out amendment notes", () => {
    const a = parseAnalysis(
      ["OLR Bill Analysis", 'SB 484 (File 591, as amended by Senate "A")*', "", "AN ACT CONCERNING DISTRACTED DRIVING.", "", "SUMMARY",
        "   This bill makes it a per se reckless driving", "violation to drive in a work zone.", "", "   Existing law prohibits driving recklessly.", "",
        " Researcher: HP                      Page 1                            4/30/26", "2026SB-00484-R01-BA.DOCX", "",
        '   *Senate Amendment "A" eliminates a provision.', "", "  EFFECTIVE DATE: October 1, 2026", "", "BACKGROUND", "Related Bill"].join("\n"),
    )!;
    expect(a.describes).toBe('File 591, as amended by Senate "A"');
    expect(a.summary)
      .toEqual(["This bill makes it a per se reckless driving violation to drive in a work zone.", "Existing law prohibits driving recklessly."]);
    expect(a.effective).toBe("October 1, 2026");
    expect(a.topics).toEqual([]);
  });

  it("reads each part of a long bill from the analysis's table of contents", () => {
    const a = parseAnalysis(
      ["OLR Bill Analysis", 'sHB 5001 (as amended by House "A")*', "", "TABLE OF CONTENTS:", "", "SUMMARY", "§§ 1, 2 & 26-28 — NO EXCUSE ABSENTEE VOTING",
        "  Expands absentee voting to all eligible voters, instead of requiring voters to have a", "  specified excuse to vote", "",
        "§ 4 — ABSENTEE BALLOT APPLICATIONS FOR INCARCERATED", "VOTERS", "  Allows DOC employees to provide facility contact information", "", "BACKGROUND", "",
        "SUMMARY", "   This bill makes various changes to the state's election laws.", "", "§§ 1, 2 & 26-28 — NO EXCUSE ABSENTEE VOTING",
        "   Body text."].join("\n"),
    )!;
    expect(a.summary).toEqual(["This bill makes various changes to the state's election laws."]);
    expect(a.topics).toHaveLength(2);
    expect(a.topics[0]).toMatchObject({ sections: "1, 2 & 26-28",
      text: "Expands absentee voting to all eligible voters, instead of requiring voters to have a specified excuse to vote" });
    expect(a.topics[1].sections).toBe("4");
    expect(a.topics[1].heading.toLowerCase()).toBe("absentee ballot applications for incarcerated voters");
    expect(parseAnalysis(["OLR Bill Analysis", "HB 2", "", "TABLE OF CONTENTS:", "", "SUMMARY", "§ 1 — DOC REPORTING UNDER SHB 5001",
      "  Requires DOC to report", "", "SUMMARY", "   This bill changes reporting."].join("\n"))!.topics[0].heading).toBe("DOC Reporting Under sHB 5001");
  });

  it("treats OLR's stub for Special Acts as no analysis, and rejoins hyphenated line breaks", () => {
    expect(parseAnalysis(["OLR Bill Analysis", "SB 267", "", "SUMMARY", "   The Office of Legislative Research does not analyze Special Acts."].join("\n")))
      .toBeNull();
    const a = parseAnalysis(["OLR Bill Analysis", "HB 1", "", "SUMMARY", "   This bill makes changes described in the section-by-",
      "section analysis below."].join("\n"))!;
    expect(a.summary).toEqual(["This bill makes changes described in the section-by-section analysis below."]);
  });

  it("looks for the amended analysis first, then the newest file copy", () => {
    expect(documentNames("HB05001", [528, 725], true, "BA"))
      .toEqual(["2026HB-05001-R03-BA.PDF", "2026HB-05001-R02-BA.PDF", "2026HB-05001-R01-BA.PDF", "2026HB-05001-R010725-BA.PDF", "2026HB-05001-R000528-BA.PDF"]);
    expect(documentNames("SB00012", [33], false, "FN")).toEqual(["2026SB-00012-R000033-FN.PDF"]);
    expect(documentNames("SB00083", [], false, "FN")).toEqual(["2026SB-00083-R00-FN.PDF"]);
  });

  it("flags a sheet whose marks disagree with its printed totals", () => {
    expect(floorAddsUp({ ...parseFloorVote(house, "2026HV-00097-R00HB05001-HV.PDF")!, yes: 9 })).toBe(false);
  });

  const floor = (number: number, yes: number, no: number, necessary = 19): FloorVote => ({ chamber: "upper", number, billNum: "HB05001", date: "2026-05-06",
    necessaryFor: "Adoption", note: "", necessary, yes, no, absent: 0, members: [] });
  const on = (raw: string, q1 = "", q2 = "") => ({ ...t(raw, q1, q2, "upper"), date: "2026-05-06" });

  it("names Senate votes by lining them up with the day's record", () => {
    const names = nameFloorVotes("HB", [floor(362, 11, 25), floor(363, 11, 25), floor(370, 25, 11)],
      [on("SEN. REJ. SEN. AMEND. SCH.", "A", "6030"), on("SEN. REJ. SEN. AMEND. SCH.", "B", "6005"), on("SEN. PASSED, HO. AMEND. SCH.", "A,E")]);
    expect(names.get(362)).toEqual({ motion: "Senate Amendment A", matched: true });
    expect(names.get(363)).toEqual({ motion: "Senate Amendment B", matched: true });
    expect(names.get(370)).toEqual({ motion: "Senate passage", matched: true });
  });

  it("does not guess when the record doesn't line up", () => {
    const names = nameFloorVotes("HB", [floor(5, 11, 25)], [on("SENATE PASSED")]);
    expect(names.get(5)).toEqual({ motion: "Senate procedural vote", matched: false });
  });

  it("treats a resolution's vote as adoption", () => {
    expect(nameFloorVotes("HJ", [floor(9, 30, 2)], []).get(9)).toEqual({ motion: "Senate adoption", matched: true });
  });

  it("counts passage and committee approval toward a scorecard, not amendments", () => {
    expect(isPassageVote("House passage")).toBe(true);
    expect(isPassageVote("Transportation Committee: Joint Favorable Substitute")).toBe(true);
    expect(isPassageVote("Judiciary Committee: Joint Favorable Change of Reference - Appropriations Committee")).toBe(true);
    for (const procedural of ["Judiciary Committee: Vote to Draft", "Judiciary Committee: Reserved for Subject Matter Public Hearing",
      "Judiciary Committee: Change of Reference - Environment Committee", "Judiciary Committee: Motion failed"]) expect(isPassageVote(procedural)).toBe(false);
    expect(isPassageVote("Senate adoption")).toBe(true);
    expect(isPassageVote("Senate Amendment B")).toBe(false);
    expect(isPassageVote("Senate amendment vote")).toBe(false);
    expect(isPassageVote("House procedural vote")).toBe(false);
    expect(isPassageVote("Transportation Committee: Joint Favorable")).toBe(true);
    expect(isPassageVote("Transportation Committee: Amendment A")).toBe(false);
  });
});
