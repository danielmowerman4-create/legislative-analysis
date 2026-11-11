// Synthetic mail for the demo. Every name is invented; bills are Demo State's.
export type DemoMessage = {
  key?: string; from: string; name?: string; subject: string; body: string; daysAgo: number;
  direction?: "inbound" | "outbound"; replyTo?: string; headers?: Record<string, string>;
};

const TRANSIT_TEMPLATE = (name: string, town: string) => `Dear Representative Ellis,

As a resident of ${town}, I urge you to support SB 112, the Public Transit Capital Fund. Reliable bus and rail service connects workers to jobs, students to school, and seniors to medical care. A dedicated capital fund would let our region plan multi-year projects instead of patching service year to year.

Please vote yes on SB 112 when it reaches the House.

Sincerely,
${name}
${town}`;

const people = [
  ["Maria Alvarez", "maria.alvarez@mail.example", "Riverside"],
  ["James Whitaker", "jwhitaker@mail.example", "Oak Hollow"],
  ["Linh Tran", "linh.tran@mail.example", "Millbrook"],
  ["Robert Haines", "rhaines@mail.example", "Cedar Falls"],
  ["Aisha Robinson", "aisha.r@mail.example", "Riverside"],
  ["Daniel Okafor", "d.okafor@mail.example", "Millbrook"],
  ["Grace Kim", "gracekim@mail.example", "Oak Hollow"],
  ["Peter Novak", "pnovak@mail.example", "Cedar Falls"],
] as const;
const TRANSIT_SURNAMES = ["Lopez", "Grant", "Meyer", "Shah", "Ward", "Fields", "Ortiz", "Young"];

export const DEMO_MESSAGES: DemoMessage[] = [
  { key: "hb142a", from: "maria.alvarez@mail.example", name: "Maria Alvarez", subject: "Please support HB 142", daysAgo: 21, body: "Dear Rep. Ellis,\n\nI am a parent of two at Riverside Elementary. Please vote yes on HB 142. The school funding formula has not kept up with enrollment, and our district is cutting reading specialists.\n\nThank you,\nMaria Alvarez" },
  { from: "jwhitaker@mail.example", name: "James Whitaker", subject: "HB 142", daysAgo: 19, body: "Representative,\n\nI oppose HB 142. Raising the base allotment without any accountability for how districts spend it is a mistake, and the appropriation is far too large for this budget year.\n\nJames Whitaker" },
  { from: "linh.tran@mail.example", name: "Linh Tran", subject: "School funding and HB 142", daysAgo: 16, body: "Hello,\n\nI would support HB 142 only if it is amended to add the rural school supplement that was discussed in committee. Small districts like ours get left behind by per-student formulas.\n\nBest,\nLinh Tran" },
  { from: "rhaines@mail.example", name: "Robert Haines", subject: "Two bills", daysAgo: 12, body: "Rep. Ellis,\n\nI support HB 142 because our teachers need the resources, but I oppose SB 40. Speed cameras near schools are a revenue grab for counties, not a safety measure.\n\nRobert Haines\nCedar Falls" },
  { from: "aisha.r@mail.example", name: "Aisha Robinson", subject: "Teacher pay", daysAgo: 9, body: "Dear Representative Ellis,\n\nTeacher pay in our county is far behind neighboring states. I strongly support HB 230 and hope you will co-sponsor it. My daughter's favorite teacher just left for a job across the state line.\n\nAisha Robinson" },
  { from: "d.okafor@mail.example", name: "Daniel Okafor", subject: "Speed cameras", daysAgo: 8, body: "Oh great, SB 40. Just what we need, more cameras mailing tickets to people driving their kids to school. Brilliant idea." },
  { from: "gracekim@mail.example", name: "Grace Kim", subject: "Question about HB 7", daysAgo: 6, body: "Hi, I saw something about HB 7 in the news. What is the status of it and when will there be a vote?" },
  { from: "pnovak@mail.example", name: "Peter Novak", subject: "Fwd: Action alert", daysAgo: 5, body: "Thought you should see this.\n\n---------- Forwarded message ---------\nFrom: Taxpayers Alliance <alerts@taxpayers.example>\nSubject: Action alert\n\nWe strongly oppose HB 142. Tell your representative to vote no!" },
  ...people.map(([name, email, town], idx) => {
    const signer = `${name.split(" ")[0]} ${TRANSIT_SURNAMES[idx]}`;
    return { from: email.replace("@", `+t${idx}@`), name: signer, subject: "Support SB 112", daysAgo: 3 + (idx % 4), body: TRANSIT_TEMPLATE(signer, town) };
  }),
  { from: "carol.b@mail.example", name: "Carol Bennett", subject: "Potholes on Route 9", daysAgo: 1, body: "The potholes on Route 9 near the Millbrook exit are dangerous. I blew a tire last night. Who is responsible for road repair there?" },
  { from: "ted.m@mail.example", name: "Ted Marsh", subject: "Road conditions", daysAgo: 2, body: "Road conditions on County Line Road are the worst I've seen in 20 years. Please push for resurfacing funding." },
  { from: "nina.p@mail.example", name: "Nina Park", subject: "Pothole damage", daysAgo: 2, body: "Second flat tire this month from potholes on Mill Street. Is there any state road maintenance money coming to our county?" },
  { from: "oscar.v@mail.example", name: "Oscar Vega", subject: "Route 9 repaving", daysAgo: 3, body: "When is Route 9 scheduled for repaving? The road conditions are getting worse every week and it's unsafe at night." },
  { from: "jane.f@mail.example", name: "Jane Foster", subject: "HB 310", daysAgo: 4, body: "I support HB 310. Our county roads need a dedicated share of fuel tax revenue for road maintenance." },
  { from: "will.h@mail.example", name: "Will Hart", subject: "Roads", daysAgo: 5, body: "The potholes downtown are getting dangerous for cyclists. Please fund road repair." },
  { from: "sue.l@mail.example", name: "Sue Lin", subject: "Potholes", daysAgo: 6, body: "Potholes everywhere on Oak Hollow Road. Can the state help the county with road repair?" },
  { from: "old.road@mail.example", name: "Hank Doyle", subject: "Road repair", daysAgo: 40, body: "The bridge approach on Elm Street needs road repair before winter." },
  { key: "ui1", from: "rosa.diaz@mail.example", name: "Rosa Diaz", subject: "Unemployment claim delay", daysAgo: 30, body: "Dear Rep. Ellis,\n\nI filed my unemployment claim with the Demo State Department of Labor eight weeks ago and have not received a single payment or letter. I can't get through on the phone. I have rent due. Can you help me?\n\nRosa Diaz\nMillbrook" },
  { key: "ui2", from: "ken.ito@mail.example", name: "Ken Ito", subject: "Overpayment notice", daysAgo: 45, body: "I got an overpayment notice from the Department of Labor saying I owe $3,200 in unemployment benefits. I was laid off and reported everything correctly. I need help with an appeal." },
  { key: "dmv1", from: "lucy.w@mail.example", name: "Lucy Webb", subject: "Driver's license reinstatement", daysAgo: 20, body: "My driver's license was suspended after a medical issue and I have been cleared by my doctor for two months, but the DMV still has not reinstated it. I need to drive to work. Can your office look into this?" },
  { key: "medicaid1", from: "frank.r@mail.example", name: "Frank Russo", subject: "Medicaid renewal", daysAgo: 4, body: "My mother's Medicaid renewal paperwork was lost twice by the Department of Health Services. Her coverage ends at the end of the month and she has a surgery scheduled. Please help." },
  { from: "beth.c@mail.example", name: "Beth Cole", subject: "Tax refund", daysAgo: 11, body: "I have been waiting four months for my state tax refund from the Department of Revenue. Is there anything your office can do?" },
  { key: "meeting1", from: "pta.riverside@mail.example", name: "Riverside PTA", subject: "Meeting request", daysAgo: 7, body: "Dear Representative Ellis,\n\nThe Riverside PTA would like to meet with you to discuss school funding and HB 142. Could we schedule a meeting at your district office in the next few weeks?\n\nThank you,\nRiverside PTA Board" },
  { from: "director@ruralhealth.example", name: "Rural Health Coalition", subject: "HB 77 implementation", daysAgo: 25, body: "Dear Rep. Ellis,\n\nOn behalf of our members, thank you for supporting HB 77. We would welcome a meeting about implementation of the rural hospital tax credit.\n\nExecutive Director\nRural Health Coalition" },
  { from: "news@statehousereport.example", name: "Statehouse Report", subject: "This week at the Capitol", daysAgo: 2, headers: { "list-id": "<weekly.statehousereport.example>", "list-unsubscribe": "<mailto:unsubscribe@statehousereport.example>" }, body: "This week: HB 142 heads to the Senate, SB 40 clears committee, and more." },
  { from: "noreply@calendar.example", subject: "Reminder: committee meeting", daysAgo: 1, headers: { "auto-submitted": "auto-generated" }, body: "This is an automated reminder of your upcoming committee meeting." },
  { from: "constituent.liaison@labor.demo-state.example", name: "DSDOL Constituent Liaison", subject: "Re: Claim inquiry", daysAgo: 10, body: "Thank you for your inquiry. The claim has been assigned to an adjudicator and the claimant will receive a determination within 10 business days." },
  { from: "s.patel@house.demo-state.example", name: "Sam Patel", subject: "HB 142 hearing prep", daysAgo: 1, body: "I'll pull the correspondence on HB 142 before the Senate hearing." },
  { from: "carmen.s@mail.example", name: "Carmen Soto", subject: "Ayuda con mi licencia", daysAgo: 3, body: "Estimado Representante Ellis,\n\nNecesito ayuda con la renovación de mi licencia de conducir. He esperado tres meses y no recibo respuesta. ¿Puede ayudarme?\n\nGracias,\nCarmen Soto" },
  { from: "tom.g@mail.example", name: "Tom Grady", subject: "Property taxes", daysAgo: 14, body: "My property tax assessment went up 38% this year. Seniors on fixed incomes cannot keep up. Please support a higher homestead exemption." },
  { from: "ellen.w@mail.example", name: "Ellen Ward", subject: "Medicaid expansion", daysAgo: 33, body: "I was disappointed that SB 18 failed in committee. I support Medicaid expansion and hope it comes back next session." },
  { from: "mike.j@mail.example", name: "Mike Jensen", subject: "SB 40 support", daysAgo: 13, body: "I support SB 40. Drivers speed through the school zone on Pine Street every morning and a crossing guard was nearly hit last month." },
  { from: "maria.alvarez@mail.example", name: "Maria Alvarez", subject: "Following up on HB 142", daysAgo: 2, body: "Following up on my earlier note. Has HB 142 been scheduled for a Senate hearing yet? Our PTA would like to testify." },
  { key: "reply1", from: "maria.alvarez@mail.example", name: "Maria Alvarez", subject: "Re: Please support HB 142", daysAgo: 20, direction: "outbound", replyTo: "hb142a", body: "Dear Ms. Alvarez,\n\nThank you for writing about HB 142. I will check with the Senate Education committee clerk and follow up with you by Friday about the hearing schedule.\n\nOffice of Rep. Ellis" },
  { from: "rosa.diaz@mail.example", name: "Rosa Diaz", subject: "Re: Unemployment claim delay", daysAgo: 0, body: "Thank you for helping. I still haven't heard from the Department of Labor. Is there any update on my claim?" },
];
