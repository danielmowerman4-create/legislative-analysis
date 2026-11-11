import type { FixtureDataset } from "../legislation/providers/fixture";
import type { NormalizedBill, NormalizedPerson } from "../legislation/types";
import type { BillRelationKind } from "../db/schema";
import { classifyAction, localTimeToIso, statusFromActions } from "../legislation/normalize";
import { stableHash } from "@/lib/chamber";

// Synthetic data for the fictional Demo State (ZZ). None of it exists.

const ZONE = "America/New_York";
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
// Today in the demo zone as midnight UTC, so day offsets never slip a day.
const dateAt = (offset: number, base: Date) => new Date(Date.parse(`${ymd.format(base)}T00:00:00Z`) + offset * 86400_000);
const day = (offset: number, base = new Date()) => dateAt(offset, base).toISOString().slice(0, 10);
const weekday = (offset: number, base = new Date()) => {
  const d = dateAt(offset, base);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

type Chamber = "upper" | "lower";
const SEATS = { lower: 180, upper: 56 } as const;
type Spec = {
  id: string;
  session?: string;
  identifier: string;
  title: string;
  summary: string;
  subjects: string[];
  sponsors: string[]; // the first is the lead sponsor
  actions: [number, string, Chamber][];
  committees?: [string, string, Chamber][];
  events?: [number, string, number, "hearing" | "floor"][]; // [days from today, title, local hour, kind]
  votes?: [number, string, number, number, Chamber][];
  versions?: [string, number, string?][];
  relations?: [string, BillRelationKind][];
};

const NAMED: [string, "R" | "D", Chamber, number][] = [
  ["Dana Whitfield", "D", "lower", 58],
  ["Marcus Bell", "R", "lower", 112],
  ["Sam Reyes", "R", "lower", 9],
  ["Priya Nandakumar", "D", "lower", 81],
  ["Ruth Calloway", "R", "lower", 147],
  ["Jordan Ellis", "D", "lower", 42],
  ["Tomás Herrera", "R", "lower", 23],
  ["Grace Okafor", "D", "lower", 90],
  ["Wade Pruitt", "R", "lower", 131],
  ["Helen Park", "D", "lower", 50],
  ["Lee Ortiz", "R", "upper", 12],
  ["Ana Morales", "D", "upper", 35],
  ["Carl Jensen", "R", "upper", 47],
  ["Denise Moultrie", "D", "upper", 6],
  ["Owen Fairley", "R", "upper", 20],
];
const FIRST = "Avery Blake Carmen Devon Elena Felix Gloria Hank Irene Jamal Keisha Luis Maya Nolan Olivia Pete Quinn Rosa Silas Tara Umar Vera Walt Xena Yusuf Zoe Abel Bonnie Cyrus Delia Ezra Fern Gus Hattie Ivan June Kurt Lena Moses Nina".split(" ");
const LAST = "Abbott Barnes Cobb Dawson Easley Fowler Gaines Holt Ingram Jessup Kendrick Lowry Mercer Nash Odom Pace Quarles Rhodes Sutton Tolbert Upshaw Vance Whitley Yancey Albright Boyd Crane Dixon Elmore Finch Greer Hollis Irby Jolly Knox Langley Maddox Norris Oakley Pickett Ragland Shealy Tatum Varner Wynn Burch Cagle Dukes Ferrell Gentry Hale Ivey Keel Lamar Monroe Neely Pope Rowe Strickland Tidwell".split(" ");

function roster(): NormalizedPerson[] {
  const people: NormalizedPerson[] = [];
  const used = new Set(NAMED.map(([n]) => n));
  let k = 0;
  const nextName = () => {
    for (;;) {
      const name = `${FIRST[(k * 7) % FIRST.length]} ${LAST[(k * 11 + Math.floor(k / LAST.length)) % LAST.length]}`;
      k++;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  for (const [chamber, majority] of [["lower", 100], ["upper", 33]] as const) {
    const seats = SEATS[chamber];
    const named = new Map(NAMED.filter((n) => n[2] === chamber).map((n) => [n[3], n]));
    for (let d = 1; d <= seats; d++) {
      const n = named.get(d);
      // A fixed permutation of seats gives each chamber its majority size.
      const party = n ? n[1] : (d * 37) % seats < majority ? "R" : "D";
      const name = n ? n[0] : nextName();
      people.push({ providerPersonId: personId(name), name, party, chamber, district: String(d) });
    }
  }
  return people;
}
const personId = (name: string) => `zz-p-${name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\W+/g, "-")}`;

const HB142_V1 = `A BILL to be entitled an Act to revise the school funding formula; to provide definitions; to provide for appropriations; to provide an effective date.

SECTION 1. Short title.
This Act shall be known as the "School Funding Formula Revision Act."

SECTION 2. Definitions.
As used in this Act, the term:
(1) "Base allotment" means the per-student amount provided to each local school system.
(2) "Local school system" means a county or independent school district.

SECTION 3. Base allotment.
Each local school system shall receive a base allotment of $6,100 per enrolled student.

SECTION 4. Appropriations.
There is appropriated $1,200,000,000 from the general fund for the purposes of this Act.

SECTION 5. Effective date.
This Act shall become effective on July 1, 2026.`;

const HB142_V2 = `A BILL to be entitled an Act to revise the school funding formula; to provide definitions; to provide for appropriations; to provide an effective date.

SECTION 1. Short title.
This Act shall be known as the "School Funding Formula Revision Act."

SECTION 2. Definitions.
As used in this Act, the term:
(1) "Base allotment" means the per-student amount provided to each local school system.
(2) "Local school system" means a county or independent school district.
(3) "Rural school system" means a local school system with fewer than 3,000 enrolled students.

SECTION 3. Base allotment.
Each local school system shall receive a base allotment of $6,350 per enrolled student. Each rural school system shall receive an additional $250 per enrolled student.

SECTION 4. Appropriations.
There is appropriated $1,350,000,000 from the general fund for the purposes of this Act.

SECTION 5. Effective date.
This Act shall become effective on July 1, 2027.

SECTION 6. Reporting.
The Department of Education shall report enrollment counts used under this Act by December 1 of each year.`;

const SB40_V1 = `A BILL to be entitled an Act to authorize automated speed enforcement in school zones.

SECTION 1. Authorization.
A county may install automated speed cameras in school zones during school hours.

SECTION 2. Penalties.
A civil penalty of $75 shall apply for a first violation.`;

const SB151_V1 = `A BILL to be entitled an Act to revise the school funding formula; to provide definitions; to provide for appropriations; to provide an effective date.

SECTION 1. Short title.
This Act shall be known as the "School Funding Formula Revision Act."

SECTION 2. Definitions.
As used in this Act, the term:
(1) "Base allotment" means the per-student amount provided to each local school system.
(2) "Local school system" means a county or independent school district.
(3) "Rural school system" means a local school system with fewer than 2,500 enrolled students.

SECTION 3. Base allotment.
Each local school system shall receive a base allotment of $6,200 per enrolled student. Each rural school system shall receive an additional $300 per enrolled student.

SECTION 4. Appropriations.
There is appropriated $1,300,000,000 from the general fund for the purposes of this Act.

SECTION 5. Effective date.
This Act shall become effective on July 1, 2027.`;

const HB388_V1 = `A BILL to be entitled an Act to repeal the authorization for automated speed enforcement in school zones.

SECTION 1. Repeal.
Any authorization for a county to install automated speed cameras in school zones is repealed.

SECTION 2. Existing devices.
Devices installed before the effective date of this Act shall be removed within 180 days.

SECTION 3. Effective date.
This Act shall become effective on July 1, 2027.`;

const HB412_V1 = `A BILL to be entitled an Act to provide literacy coaches in early grades.

SECTION 1. Literacy coaches.
Each local school system shall employ at least one literacy coach for every 400 students enrolled in kindergarten through third grade.

SECTION 2. Funding.
There is appropriated $42,000,000 from the general fund for literacy coaches.

SECTION 3. Effective date.
This Act shall become effective on July 1, 2027.`;

const SB205_V1 = `A BILL to be entitled an Act to set standards for literacy instruction in early grades.

SECTION 1. Instruction standards.
Each local school system shall use reading curricula approved by the State Board of Education for kindergarten through third grade.

SECTION 2. Literacy coaches.
Each local school system may employ literacy coaches for students enrolled in kindergarten through third grade.

SECTION 3. Effective date.
This Act shall become effective on July 1, 2026.`;

const SPECS: Spec[] = [
  {
    id: "zz-hb142",
    identifier: "HB 142",
    title: "School Funding Formula Revision Act",
    summary: "Amends Code Section 20-2-161 to revise the per-student base allotment for local school systems and appropriates funds for the formula.",
    subjects: ["Education", "Appropriations"],
    sponsors: ["Dana Whitfield", "Marcus Bell", "Jordan Ellis"],
    actions: [
      [-120, "Introduced and first reading", "lower"],
      [-118, "Referred to House Education Committee", "lower"],
      [-60, "Committee substitute adopted; favorably reported by substitute", "lower"],
      [-55, "Third reading passed (112-58)", "lower"],
      [-50, "Referred to Senate Education and Youth Committee", "upper"],
      [-4, "Hearing scheduled in Senate Education and Youth Committee", "upper"],
    ],
    committees: [["zz-c-hed", "House Education", "lower"], ["zz-c-sedu", "Senate Education and Youth", "upper"]],
    events: [[3, "Senate Education and Youth Committee hearing", 14, "hearing"]],
    votes: [
      [-60, "House Education Committee: do pass by substitute", 9, 4, "lower"],
      [-55, "House third reading", 112, 58, "lower"],
    ],
    versions: [["Introduced", -120, HB142_V1], ["House Committee Substitute", -60, HB142_V2]],
  },
  {
    id: "zz-sb151",
    identifier: "SB 151",
    title: "School Funding Formula Revision Act",
    summary: "Senate companion to HB 142. Amends Code Section 20-2-161 to raise the per-student base allotment and add a rural supplement.",
    subjects: ["Education", "Appropriations"],
    sponsors: ["Denise Moultrie", "Carl Jensen"],
    actions: [
      [-110, "Introduced and first reading", "upper"],
      [-108, "Referred to Senate Education and Youth Committee", "upper"],
    ],
    committees: [["zz-c-sedu", "Senate Education and Youth", "upper"]],
    events: [[3, "Senate Education and Youth Committee hearing", 14, "hearing"]],
    versions: [["Introduced", -110, SB151_V1]],
    relations: [["zz-hb142", "similar_to"]],
  },
  {
    id: "zz-sb40",
    identifier: "SB 40",
    title: "Speed Camera Expansion in School Zones",
    summary: "Amends Code Section 40-14-18 to authorize counties to operate automated speed cameras in school zones during school hours.",
    subjects: ["Transportation", "Public Safety"],
    sponsors: ["Lee Ortiz"],
    actions: [
      [-90, "Introduced and first reading", "upper"],
      [-88, "Referred to Senate Public Safety Committee", "upper"],
      [-40, "Favorably reported", "upper"],
    ],
    committees: [["zz-c-sps", "Senate Public Safety", "upper"]],
    events: [[6, "Senate floor session: third reading", 10, "floor"]],
    votes: [[-40, "Senate Public Safety Committee: do pass", 5, 2, "upper"]],
    versions: [["Introduced", -90, SB40_V1]],
  },
  {
    id: "zz-hb388",
    identifier: "HB 388",
    title: "School Zone Speed Camera Repeal",
    summary: "Repeals the school zone camera authorization in Code Section 40-14-18 and requires existing cameras to be removed.",
    subjects: ["Transportation", "Public Safety"],
    sponsors: ["Wade Pruitt", "Tomás Herrera"],
    actions: [
      [-30, "Introduced and first reading", "lower"],
      [-29, "Referred to House Public Safety Committee", "lower"],
    ],
    committees: [["zz-c-hps", "House Public Safety", "lower"]],
    events: [[8, "House Public Safety Committee hearing", 13, "hearing"]],
    versions: [["Introduced", -30, HB388_V1]],
  },
  {
    id: "zz-hb77",
    identifier: "HB 77",
    title: "Rural Hospital Tax Credit Extension",
    summary: "Amends Code Section 48-7-29.20 to extend the income tax credit for donations to qualified rural hospital organizations.",
    subjects: ["Health", "Taxation"],
    sponsors: ["Sam Reyes", "Priya Nandakumar"],
    actions: [
      [-150, "Introduced and first reading", "lower"],
      [-148, "Referred to House Ways and Means Committee", "lower"],
      [-100, "Favorably reported", "lower"],
      [-95, "Third reading passed (150-20)", "lower"],
      [-80, "Referred to Senate Finance Committee", "upper"],
      [-70, "Third reading passed (48-6)", "upper"],
      [-55, "Sent to Governor", "lower"],
      [-40, "Signed by Governor; Act 212", "lower"],
    ],
    committees: [["zz-c-hwm", "House Ways and Means", "lower"], ["zz-c-sfin", "Senate Finance", "upper"]],
    votes: [[-95, "House third reading", 150, 20, "lower"], [-70, "Senate third reading", 48, 6, "upper"]],
    versions: [["Introduced", -150], ["Enrolled", -60]],
  },
  {
    id: "zz-hb321-2024",
    session: "2023-2024",
    identifier: "HB 321",
    title: "Rural Hospital Tax Credit Increase",
    summary: "Amends Code Section 48-7-29.20 to raise the annual cap on the rural hospital donation tax credit.",
    subjects: ["Health", "Taxation"],
    sponsors: ["Sam Reyes"],
    actions: [
      [-640, "Introduced and first reading", "lower"],
      [-638, "Referred to House Ways and Means Committee", "lower"],
      [-600, "Third reading passed (161-9)", "lower"],
      [-590, "Referred to Senate Finance Committee", "upper"],
      [-575, "Third reading passed (51-2)", "upper"],
      [-540, "Signed by Governor; Act 88", "lower"],
    ],
    committees: [["zz-c-hwm", "House Ways and Means", "lower"], ["zz-c-sfin", "Senate Finance", "upper"]],
  },
  {
    id: "zz-hb7-reg",
    identifier: "HB 7",
    title: "Property Tax Homestead Exemption Increase",
    summary: "Amends Code Section 48-5-44 to raise the statewide homestead exemption for primary residences.",
    subjects: ["Taxation", "Housing"],
    sponsors: ["Ruth Calloway"],
    actions: [
      [-200, "Introduced and first reading", "lower"],
      [-198, "Referred to House Ways and Means Committee", "lower"],
    ],
    committees: [["zz-c-hwm", "House Ways and Means", "lower"]],
  },
  {
    id: "zz-hb7-spec",
    session: "2026S1",
    identifier: "HB 7",
    title: "Special Session Disaster Relief Appropriation",
    summary: "Appropriates emergency funds for storm recovery in affected counties.",
    subjects: ["Appropriations", "Emergency Management"],
    sponsors: ["Dana Whitfield"],
    actions: [
      [-20, "Introduced and first reading", "lower"],
      [-19, "Referred to House Appropriations Committee", "lower"],
    ],
    committees: [["zz-c-happ", "House Appropriations", "lower"]],
    events: [[5, "House Appropriations Committee hearing", 9, "hearing"]],
  },
  {
    id: "zz-sb112",
    identifier: "SB 112",
    title: "Public Transit Capital Fund",
    summary: "Creates Article 10 of Chapter 9 of Title 32, a dedicated capital fund for regional bus and rail projects.",
    subjects: ["Transportation"],
    sponsors: ["Ana Morales"],
    actions: [
      [-80, "Introduced and first reading", "upper"],
      [-79, "Referred to Senate Transportation Committee", "upper"],
    ],
    committees: [["zz-c-strn", "Senate Transportation", "upper"]],
    events: [[2, "Senate Transportation Committee hearing", 15, "hearing"]],
  },
  {
    id: "zz-hb310",
    identifier: "HB 310",
    title: "Road Maintenance Funding Formula",
    summary: "Amends Code Section 32-5-27 to direct a share of motor fuel revenue to county road resurfacing.",
    subjects: ["Transportation", "Appropriations"],
    sponsors: ["Jordan Ellis"],
    actions: [
      [-45, "Introduced and first reading", "lower"],
      [-44, "Referred to House Transportation Committee", "lower"],
    ],
    committees: [["zz-c-htrn", "House Transportation", "lower"]],
  },
  {
    id: "zz-hb230",
    identifier: "HB 230",
    title: "Teacher Salary Schedule Adjustment",
    summary: "Amends Code Section 20-2-212 to increase the state minimum salary schedule for certified teachers.",
    subjects: ["Education"],
    sponsors: ["Priya Nandakumar", "Jordan Ellis"],
    actions: [
      [-70, "Introduced and first reading", "lower"],
      [-68, "Referred to House Education Committee", "lower"],
      [-14, "Amendment filed in committee", "lower"],
    ],
    committees: [["zz-c-hed", "House Education", "lower"]],
  },
  {
    id: "zz-hb905-2024",
    session: "2023-2024",
    identifier: "HB 905",
    title: "Teacher Salary Schedule Adjustment",
    summary: "Amends Code Section 20-2-212 to increase the state minimum salary schedule for certified teachers.",
    subjects: ["Education"],
    sponsors: ["Priya Nandakumar"],
    actions: [
      [-700, "Introduced and first reading", "lower"],
      [-698, "Referred to House Education Committee", "lower"],
      [-560, "Died in committee at sine die", "lower"],
    ],
    committees: [["zz-c-hed", "House Education", "lower"]],
  },
  {
    id: "zz-sb18",
    identifier: "SB 18",
    title: "Medicaid Eligibility Expansion",
    summary: "Amends Code Section 49-4-142 to expand Medicaid eligibility to adults with incomes up to 138 percent of the federal poverty level.",
    subjects: ["Health"],
    sponsors: ["Ana Morales"],
    actions: [
      [-160, "Introduced and first reading", "upper"],
      [-158, "Referred to Senate Health and Human Services Committee", "upper"],
      [-30, "Failed in committee", "upper"],
    ],
    committees: [["zz-c-shhs", "Senate Health and Human Services", "upper"]],
    votes: [[-30, "Senate Health and Human Services Committee: do pass", 4, 7, "upper"]],
  },
  {
    id: "zz-hb95",
    identifier: "HB 95",
    title: "Unemployment Claims Processing Standards",
    summary: "Amends Code Section 34-8-190 to set processing timelines for unemployment claims and require status notices to claimants.",
    subjects: ["Labor and Employment"],
    sponsors: ["Marcus Bell"],
    actions: [
      [-110, "Introduced and first reading", "lower"],
      [-108, "Referred to House Labor Committee", "lower"],
      [-75, "Favorably reported", "lower"],
      [-70, "Third reading passed (160-8)", "lower"],
      [-50, "Referred to Senate Insurance and Labor Committee", "upper"],
      [-35, "Third reading passed (50-2)", "upper"],
      [-20, "Sent to Governor", "lower"],
      [-10, "Vetoed by Governor", "lower"],
    ],
    committees: [["zz-c-hlab", "House Labor", "lower"], ["zz-c-sil", "Senate Insurance and Labor", "upper"]],
    votes: [[-70, "House third reading", 160, 8, "lower"], [-35, "Senate third reading", 50, 2, "upper"]],
  },
  {
    id: "zz-hb412",
    identifier: "HB 412",
    title: "Early Literacy Coaches Act",
    summary: "Amends Code Section 20-2-153 to require literacy coaches in kindergarten through third grade and fund them.",
    subjects: ["Education"],
    sponsors: ["Jordan Ellis", "Grace Okafor", "Wade Pruitt"],
    actions: [
      [-40, "Introduced and first reading", "lower"],
      [-39, "Referred to House Education Committee", "lower"],
      [-5, "Hearing scheduled in House Education Committee", "lower"],
    ],
    committees: [["zz-c-hed", "House Education", "lower"]],
    events: [[1, "House Education Committee hearing", 13, "hearing"]],
    versions: [["Introduced", -40, HB412_V1]],
  },
  {
    id: "zz-sb205",
    identifier: "SB 205",
    title: "Literacy Instruction Standards",
    summary: "Amends Code Section 20-2-153 to set approved reading curricula for early grades and allow literacy coaches.",
    subjects: ["Education"],
    sponsors: ["Owen Fairley"],
    actions: [
      [-60, "Introduced and first reading", "upper"],
      [-58, "Referred to Senate Education and Youth Committee", "upper"],
      [-20, "Favorably reported", "upper"],
      [-12, "Third reading passed (50-3)", "upper"],
      [-10, "Referred to House Education Committee", "lower"],
    ],
    committees: [["zz-c-sedu", "Senate Education and Youth", "upper"], ["zz-c-hed", "House Education", "lower"]],
    events: [[1, "House Education Committee hearing", 13, "hearing"]],
    votes: [[-20, "Senate Education and Youth Committee: do pass", 8, 1, "upper"], [-12, "Senate third reading", 50, 3, "upper"]],
    versions: [["Introduced", -60, SB205_V1]],
  },
  {
    id: "zz-hr44",
    identifier: "HR 44",
    title: "Recognizing Rural Teachers Week",
    summary: "Recognizes the first week of March as Rural Teachers Week.",
    subjects: ["Education", "Resolutions"],
    sponsors: ["Grace Okafor", "Jordan Ellis"],
    actions: [
      [-25, "Introduced and first reading", "lower"],
      [-24, "Referred to House Rules Committee", "lower"],
      [-15, "Adopted", "lower"],
    ],
    committees: [["zz-c-hrul", "House Rules", "lower"]],
  },
  {
    id: "zz-hb501",
    identifier: "HB 501",
    title: "Broadband Expansion Grants",
    summary: "Amends Chapter 8 of Title 50 to create matching grants for broadband service in unserved areas.",
    subjects: ["Technology", "Rural Development"],
    sponsors: ["Helen Park", "Wade Pruitt", "Jordan Ellis"],
    actions: [
      [-75, "Introduced and first reading", "lower"],
      [-73, "Referred to House Energy, Utilities and Telecommunications Committee", "lower"],
      [-30, "Favorably reported", "lower"],
      [-20, "Third reading passed (164-10)", "lower"],
      [-18, "Referred to Senate Regulated Industries Committee", "upper"],
    ],
    committees: [["zz-c-heut", "House Energy, Utilities and Telecommunications", "lower"], ["zz-c-sreg", "Senate Regulated Industries", "upper"]],
    events: [[4, "Senate Regulated Industries Committee hearing", 10, "hearing"]],
    votes: [[-20, "House third reading", 164, 10, "lower"]],
  },
  {
    id: "zz-sb99",
    identifier: "SB 99",
    title: "Rural Broadband Infrastructure Act",
    summary: "Amends Chapter 8 of Title 50 to let electric membership corporations offer broadband service.",
    subjects: ["Technology", "Rural Development"],
    sponsors: ["Carl Jensen"],
    actions: [
      [-65, "Introduced and first reading", "upper"],
      [-63, "Referred to Senate Regulated Industries Committee", "upper"],
    ],
    committees: [["zz-c-sreg", "Senate Regulated Industries", "upper"]],
  },
  {
    id: "zz-hb615",
    identifier: "HB 615",
    title: "Juvenile Court Records Sealing",
    summary: "Amends Code Section 15-11-701 to seal juvenile court records automatically after two years without a new offense.",
    subjects: ["Courts", "Juvenile Justice"],
    sponsors: ["Tomás Herrera", "Helen Park"],
    actions: [
      [-3, "Introduced and first reading", "lower"],
      [-2, "Referred to House Judiciary (Non-Civil) Committee", "lower"],
    ],
    committees: [["zz-c-hjnc", "House Judiciary (Non-Civil)", "lower"]],
    events: [[7, "House Judiciary (Non-Civil) Committee hearing", 15, "hearing"]],
  },
  {
    id: "zz-hb128",
    identifier: "HB 128",
    title: "Hands-Free Driving Penalties",
    summary: "Amends Code Section 40-6-241 to raise fines for holding a phone while driving.",
    subjects: ["Transportation", "Public Safety"],
    sponsors: ["Marcus Bell", "Dana Whitfield"],
    actions: [
      [-85, "Introduced and first reading", "lower"],
      [-84, "Referred to House Public Safety Committee", "lower"],
      [-50, "Favorably reported", "lower"],
      [-45, "Third reading passed (141-31)", "lower"],
      [-40, "Referred to Senate Public Safety Committee", "upper"],
      [-15, "Favorably reported", "upper"],
      [-6, "Third reading passed (39-15)", "upper"],
      [-2, "Sent to Governor", "lower"],
    ],
    committees: [["zz-c-hps", "House Public Safety", "lower"], ["zz-c-sps", "Senate Public Safety", "upper"]],
    votes: [[-45, "House third reading", 141, 31, "lower"], [-6, "Senate third reading", 39, 15, "upper"]],
  },
];

export const DEMO_SESSIONS = (now = new Date()) => [
  { providerId: "2025-2026", identifier: "2025-2026", name: "2025-2026 Regular Session", startDate: "2025-01-13", endDate: `${now.getFullYear()}-12-31`, isSpecial: false },
  { providerId: "2026S1", identifier: "2026 First Special Session", name: "2026 First Special Session", startDate: day(-25, now), endDate: day(45, now), isSpecial: true },
  { providerId: "2023-2024", identifier: "2023-2024", name: "2023-2024 Regular Session", startDate: "2023-01-09", endDate: "2024-12-31", isSpecial: false },
];

function memberVotes(people: NormalizedPerson[], chamber: Chamber, yes: number, no: number, leadParty: string | null, salt: string) {
  const members = people
    .filter((p) => p.chamber === chamber)
    .sort((a, b) => Number(b.party === leadParty) - Number(a.party === leadParty) || stableHash(a.name + salt) - stableHash(b.name + salt));
  const vote = (i: number) => (i < yes ? "yes" : i < yes + no ? "no" : "not_voting") as "yes" | "no" | "not_voting";
  return members.map((p, i) => ({ name: p.name, providerPersonId: p.providerPersonId, vote: vote(i) }));
}

export function demoLegislativeDataset(now = new Date()): FixtureDataset {
  const people = roster();
  const byName = new Map(people.map((p) => [p.name, p]));
  const rollCallVotes: NonNullable<FixtureDataset["rollCallVotes"]> = {};
  const bills = SPECS.map((s): NormalizedBill & { versionTexts?: Record<string, string> } => {
    const [type, num] = s.identifier.split(" ");
    const actions = s.actions.map(([off, description, chamber], i) => ({
      providerKey: `${s.id}-a${i}`, date: day(off, now), chamber, description, classification: classifyAction(description),
    }));
    const specVersions = s.versions ?? [];
    const vid = (i: number) => `${s.id}-v${i}`;
    const versions = specVersions.map(([label, off], i) => ({ providerVersionId: vid(i), label, date: day(off, now), url: null, mimeType: "text/plain" }));
    const texts = Object.fromEntries(specVersions.flatMap(([, , text], i) => (text ? [[vid(i), text]] : [])));
    const last = actions[actions.length - 1];
    const lead = byName.get(s.sponsors[0]);
    const votes = (s.votes ?? []).map(([off, motion, yes, no, chamber], i) => {
      const id = `${s.id}-rc${i}`;
      const committee = /committee/i.test(motion);
      if (!committee) rollCallVotes[id] = memberVotes(people, chamber, yes, no, lead?.party ?? null, id);
      const other = committee ? 0 : SEATS[chamber] - yes - no;
      return { providerRollCallId: id, date: day(off, now), chamber, motion, yes, no, other, passed: yes > no, url: null };
    });
    return {
      providerBillId: s.id, sessionProviderId: s.session ?? "2025-2026", identifier: s.identifier, billType: type, number: Number(num),
      chamber: type.startsWith("S") ? "upper" : "lower", title: s.title, officialSummary: s.summary, status: statusFromActions(actions),
      statusText: last.description, statusDate: last.date, introducedAt: actions[0].date, lastActionAt: last.date, lastActionText: last.description,
      effectiveDate: null, subjects: s.subjects, sourceUrls: [{ label: "Demo source (fictional)", url: `https://example.org/demo-state/${s.id}` }],
      changeHash: null, sourceUpdatedAt: now.toISOString(),
      sponsors: s.sponsors.map((name, i) => {
        const p = byName.get(name);
        return {
          name, type: i === 0 ? "primary" : "cosponsor", providerPersonId: p?.providerPersonId ?? personId(name),
          party: p?.party ?? null, district: p?.district ?? null, chamber: p?.chamber ?? null,
        };
      }),
      actions, versions, amendments: [], votes,
      committees: (s.committees ?? []).map(([id, name, chamber]) => {
        const referredAt = actions.find((a) => a.classification.includes("referred") && a.chamber === chamber)?.date ?? null;
        return { providerCommitteeId: id, name, chamber, referredAt };
      }),
      events: (s.events ?? []).map(([off, title, hour, kind]) => ({
        // Bills at one hearing share this id; it uses the offset so restarts move it.
        providerEventId: `ev-${off}-${title.toLowerCase().replace(/\W+/g, "-")}`, title, startsAt: localTimeToIso(weekday(off, now), `${hour}:00`, ZONE)!,
        location: kind === "floor" ? "Demo State Capitol, Senate Chamber" : "Demo State Capitol, Room 341", kind,
      })),
      relations: (s.relations ?? []).map(([pid, kind]) => ({ providerBillId: pid, identifier: SPECS.find((x) => x.id === pid)?.identifier ?? pid, kind })),
      versionTexts: texts,
    };
  });
  return { sessions: DEMO_SESSIONS(now), bills, people, rollCallVotes };
}
