// A made-up Georgia House office's mailbox; no person or letter here is real.
export const OFFICE_ADDRESS = "rep.test@house.ga.gov";
export const BANNER = "CAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.";

const domainOf = (address: string) => address.split("@")[1];
const SERVER = "mx.house.ga.gov";
export const confirmed = (address: string) => `${SERVER}; spf=pass (sender IP is 209.85.220.41) smtp.mailfrom=${domainOf(address)}; dkim=pass (signature was verified) header.d=${domainOf(address)};dmarc=pass action=none header.from=${domainOf(address)};compauth=pass reason=100`;
export const throughFilter = (address: string) => `${SERVER}; spf=fail (sender IP is 68.232.141.10) smtp.mailfrom=${domainOf(address)}; dkim=pass (signature was verified) header.d=${domainOf(address)};dmarc=pass action=none header.from=${domainOf(address)};compauth=pass reason=100`;
export const forged = (address: string) => `${SERVER}; spf=fail (sender IP is 203.0.113.9) smtp.mailfrom=bulk-sender.example; dkim=none (message not signed) header.d=none;dmarc=fail action=oreject header.from=${domainOf(address)};compauth=fail reason=000`;

export type Letter = {
  key: string;
  folder?: "INBOX" | "Sent";
  from: string;
  to?: string;
  replyTo?: string;
  subject: string;
  body?: string;
  html?: string;
  // null leaves the Authentication-Results header off.
  auth?: string | null;
  headers?: Record<string, string>;
  hoursAgo?: number;
  inReplyTo?: string;
  banner?: boolean;
  attachment?: { name: string; type: string; text: string };
};

const address = (from: string) => from.match(/<([^>]+)>/)?.[1] ?? from;

export function toMime(l: Letter): string {
  const sender = address(l.from);
  const inbound = (l.folder ?? "INBOX") === "INBOX";
  const auth = l.auth === undefined ? (inbound ? confirmed(sender) : null) : l.auth;
  const withBanner = inbound && l.banner !== false && auth !== null && !l.headers?.["X-MS-Exchange-Organization-AuthAs"];
  const text = l.body === undefined ? undefined : `${withBanner ? `${BANNER}\n\n` : ""}${l.body}`.replace(/\r?\n/g, "\r\n");
  const html = l.html === undefined ? undefined : `<html><body>${withBanner ? `<table><tr><td style="background:#fff3cd"><b>CAUTION:</b> This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.</td></tr></table>` : ""}${l.html}</body></html>`;
  const head = [
    ...(auth ? [`Authentication-Results: ${auth}`] : []),
    ...Object.entries(l.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `From: ${l.from}`,
    `To: ${l.to ?? (inbound ? OFFICE_ADDRESS : "someone@example.org")}`,
    ...(l.replyTo ? [`Reply-To: ${l.replyTo}`] : []),
    `Subject: ${l.subject}`,
    `Date: ${new Date(Date.now() - (l.hoursAgo ?? 1) * 3600_000).toUTCString()}`,
    `Message-ID: <${l.key}@${domainOf(sender)}>`,
    ...(l.inReplyTo ? [`In-Reply-To: <${l.inReplyTo}>`, `References: <${l.inReplyTo}>`] : []),
    "MIME-Version: 1.0",
  ];
  const part = (type: string, content: string) => `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${content}\r\n`;
  if (l.attachment) {
    const b = "=_mixed_boundary";
    const file = `Content-Type: ${l.attachment.type}; name="${l.attachment.name}"\r\nContent-Disposition: attachment; filename="${l.attachment.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(l.attachment.text).toString("base64")}\r\n`;
    return `${head.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${part("text/plain", text ?? "")}--${b}\r\n${file}--${b}--\r\n`;
  }
  if (text !== undefined && html !== undefined) {
    const b = "=_alt_boundary";
    return `${head.join("\r\n")}\r\nContent-Type: multipart/alternative; boundary="${b}"\r\n\r\n--${b}\r\n${part("text/plain", text)}--${b}\r\n${part("text/html", html)}--${b}--\r\n`;
  }
  return `${head.join("\r\n")}\r\n${part(html !== undefined ? "text/html" : "text/plain", html ?? text ?? "")}`;
}

const TRANSIT = "As your constituent, I urge you to support SB 112, the Public Transit Capital Fund. Reliable buses connect workers to jobs across our county, reduce traffic on our roads, and give seniors a way to reach their doctors. Please vote yes when it reaches the floor.";
const TEACHERS = "I am writing to ask you to vote yes on HB 230, the Teacher Salary Schedule Adjustment. Our teachers have gone years without a meaningful raise while the cost of living keeps climbing, and too many are leaving for neighboring states. Please support this bill.";
const UNSUBSCRIBE = { "List-Unsubscribe": "<mailto:unsubscribe@votervoice.net>", Precedence: "bulk" };

export const LETTERS: Letter[] = [
  { key: "support-number", from: "Ann Lee <ann.lee@gmail.com>", subject: "Please vote yes on HB 142", hoursAgo: 70, body: "Dear Representative,\n\nPlease vote YES on HB 142. Our schools in the district are short of what the current formula promises, and my two children feel it every day.\n\nThank you,\nAnn Lee\n12 Elm Street\nAlpharetta, GA 30009" },
  { key: "oppose-spelled", from: "Ben Ray <ben.ray@yahoo.com>", subject: "Speed cameras", hoursAgo: 69, body: "Representative,\n\nI urge you to vote against House Bill 388. The cameras near Crabapple Elementary slowed traffic and I oppose repealing them.\n\nBen Ray\n48 Mayfield Road\nAlpharetta, GA 30009" },
  { key: "name-only", from: "Cy Dunn <cy.dunn@gmail.com>", subject: "Internet access", hoursAgo: 68,
    body: "Hello,\n\nPlease support the Rural Broadband Infrastructure Act. My parents still cannot get a reliable connection at their farm.\n\nCy Dunn" },
  { key: "typo-number", from: "Dee Fox <dee.fox@outlook.com>", subject: "School funding", hoursAgo: 67,
    body: "I am writing to support HB 124. The school funding formula needs revision this year, not next.\n\nDee Fox" },
  { key: "conditional", from: "Eli Gant <eli.gant@gmail.com>", subject: "SB 18", hoursAgo: 66,
    body: "I support SB 18, but only if the work requirement is removed. As written it would cut off people who are caring for family.\n\nEli Gant" },
  { key: "federal", from: "Fay Hale <fay.hale@gmail.com>", subject: "Call Congress", hoursAgo: 65,
    body: "Please tell Congress to pass H.R. 44 on veterans' health care. Our U.S. Senator has not answered my letters.\n\nFay Hale" },
  { key: "no-bill-stance", from: "Gus Irwin <gus.irwin@gmail.com>", subject: "Teacher pay", hoursAgo: 64,
    body: "I oppose any cut to teacher pay in next year's budget. Our county is already losing teachers to other states.\n\nGus Irwin\nRoswell" },

  { key: "casework-ui", from: "Hal Jones <hal.jones@gmail.com>", subject: "Unemployment claim stuck", hoursAgo: 60, body: "Hello,\n\nI need help with my unemployment claim. I filed with the Georgia Department of Labor eight weeks ago and have not received a single payment. Nobody answers the phone. My claim number is 4471902. Can you look into this?\n\nHal Jones\n770-555-0142\n301 Kimball Bridge Road\nAlpharetta, GA 30022" },
  { key: "casework-es", from: "Ines Kline <ines.kline@gmail.com>", subject: "Ayuda con mi licencia", hoursAgo: 59, body: "Buenos días,\n\nNecesito ayuda con mi licencia de conducir. He esperado tres meses y el Departamento de Servicios para Conductores no me responde.\n\nGracias,\nInés Kline" },
  { key: "urgent-eviction", from: "Jo Lamb <jo.lamb@gmail.com>", subject: "Eviction this Friday", hoursAgo: 20, body: "Please help. My landlord says we will be evicted this Friday and the housing authority has not processed my emergency rental assistance. I have three kids and nowhere to go.\n\nJo Lamb" },
  { key: "safety", from: "Kit Moss <kit.moss@gmail.com>", subject: "I can't do this anymore", hoursAgo: 3, body: "I lost my job and my benefits were cut off. I don't see a way out and I have been thinking about ending my life. I don't know who else to write to.\n\nKit" },
  { key: "two-asks", from: "Lou Nash <lou.nash@gmail.com>", subject: "Two things", hoursAgo: 58, body: "Representative,\n\nFirst, please vote yes on HB 95 so claims get processed on time. Second, I need help with my own case: my state tax refund has been stuck with the Department of Revenue since March and no one has responded.\n\nLou Nash" },

  { key: "meeting", from: "Mae Otis <mae.otis@crabapplepta.org>", subject: "Meeting request from the Crabapple PTA", hoursAgo: 57, body: "Dear Representative,\n\nThe Crabapple PTA would like to meet with you before the session starts. Could we schedule a meeting at your office the week of the 12th?\n\nMae Otis\nPresident, Crabapple PTA" },
  { key: "media", from: "Ned Pike <npike@ajc.com>", subject: "Comment for a story", hoursAgo: 5, body: "Hi, I'm a reporter with the Atlanta Journal-Constitution working on a story about school funding. I am on deadline today at 5 and requesting a comment on HB 142.\n\nNed Pike" },
  { key: "vendor", from: "Sales Team <sales@civicsoft.io>", subject: "Tools for legislative offices", hoursAgo: 56, body: "Hi there,\n\nWe help legislators manage constituent mail. Our platform can cut your response time in half. Schedule a quick demo this week and get special pricing.\n\nThe CivicSoft Team" },
  { key: "lobbyist", from: "Ora Quinn <oquinn@gahospitals.org>", subject: "HB 77", hoursAgo: 55, body: "Representative,\n\nOn behalf of our members, the Georgia Rural Hospital Coalition urges you to support HB 77. I am a registered lobbyist for the Coalition and would be glad to answer questions.\n\nOra Quinn\nGovernment Affairs Director\nGeorgia Rural Hospital Coalition" },
  { key: "agency", from: "Constituent Services <constituent.services@gdol.ga.gov>", subject: "RE: Claim 4471902", hoursAgo: 10, body: "Good afternoon,\n\nWe have located the claim and it has been released for payment. The claimant should see a deposit within three business days.\n\nOffice of Constituent Services\nGeorgia Department of Labor" },
  { key: "internal", from: "Pat Reed <pat.reed@house.ga.gov>", subject: "Committee schedule", hoursAgo: 9, banner: false,
    body: "The Education committee meets Tuesday at 2 in room 406. Agenda attached to the calendar invite.\n\nPat" },
  { key: "newsletter", from: "Georgia Builders Weekly <news@gabuilders.org>", subject: "This week in construction", hoursAgo: 54,
    headers: { "List-Unsubscribe": "<https://gabuilders.org/unsubscribe>", "List-Id": "<weekly.gabuilders.org>" },
    body: "Top stories this week: permits are up 4 percent, a new code cycle begins in January, and registration is open for the fall conference." },
  { key: "autoreply", from: "Ann Lee <ann.lee@gmail.com>", subject: "Automatic reply: Thank you for writing", hoursAgo: 53,
    headers: { "Auto-Submitted": "auto-replied" }, body: "I am out of the office until Monday and will reply when I return." },
  { key: "thanks", from: "Quin Shaw <quin.shaw@gmail.com>", subject: "Thank you", hoursAgo: 52,
    body: "Just a note to say thank you for coming to the Wills Park cleanup on Saturday. It meant a lot to the neighborhood.\n\nQuin Shaw" },

  { key: "forged", from: "Ann Lee <ann.lee@gmail.com>", subject: "Vote no on HB 142", hoursAgo: 51, auth: forged("ann.lee@gmail.com"),
    body: "I have changed my mind. Vote NO on HB 142.\n\nAnn Lee" },
  { key: "unconfirmed", from: "Ray Tate <ray.tate@smalltown-isp.net>", subject: "Road paving", hoursAgo: 50, auth: null,
    body: "When will Bethany Road be repaved? The potholes are getting worse.\n\nRay Tate" },
  { key: "through-filter", from: "Sue Vance <sue.vance@gmail.com>", subject: "Hands-free law", hoursAgo: 49, auth: throughFilter("sue.vance@gmail.com"),
    body: "Please support HB 128. I was rear-ended last year by a driver looking at a phone.\n\nSue Vance" },

  { key: "platform-1", from: "Tom Ueda via VoterVoice <noreply@votervoice.net>", replyTo: "Tom Ueda <tom.ueda@gmail.com>",
    subject: "Support the Public Transit Capital Fund", hoursAgo: 40, headers: UNSUBSCRIBE,
    body: `Dear Representative,\n\n${TRANSIT}\n\nSincerely,\nTom Ueda\n88 Canton Street\nAlpharetta, GA 30009` },
  { key: "platform-2", from: "Uma Voss via VoterVoice <noreply@votervoice.net>", replyTo: "Uma Voss <uma.voss@yahoo.com>",
    subject: "Support the Public Transit Capital Fund", hoursAgo: 39, headers: UNSUBSCRIBE,
    body: `Dear Representative,\n\n${TRANSIT}\n\nSincerely,\nUma Voss` },
  { key: "platform-3", from: "Vic Wren via VoterVoice <noreply@votervoice.net>", replyTo: "Vic Wren <vic.wren@gmail.com>", subject: "Support the Public Transit Capital Fund", hoursAgo: 38, headers: UNSUBSCRIBE, body: `Dear Representative,\n\nI am blind and the 85 bus is the only way I get to work. Last month it was cut to once an hour.\n\n${TRANSIT}\n\nSincerely,\nVic Wren` },
  { key: "direct-form-1", from: "Wes Young <wes.young@gmail.com>", subject: "Teacher pay", hoursAgo: 37, body: `${TEACHERS}\n\nWes Young` },
  { key: "direct-form-2", from: "Xan Zeller <xan.zeller@gmail.com>", subject: "HB 230", hoursAgo: 36, body: `${TEACHERS}\n\nXan Zeller` },
  { key: "direct-form-3", from: "Yul Abbot <yul.abbot@gmail.com>", subject: "Please pass HB 230", hoursAgo: 35, body: `${TEACHERS}\n\nMy wife has taught third grade at Manning Oaks for eleven years and now works weekends at a restaurant to cover our rent.\n\nYul Abbot` },
  { key: "duplicate", from: "Ann Lee <ann.lee@gmail.com>", subject: "Please vote yes on HB 142", hoursAgo: 34, body: "Dear Representative,\n\nPlease vote YES on HB 142. Our schools in the district are short of what the current formula promises, and my two children feel it every day.\n\nThank you,\nAnn Lee\n12 Elm Street\nAlpharetta, GA 30009" },

  { key: "reply-quoted", from: "Hal Jones <hal.jones@gmail.com>", subject: "RE: Unemployment claim stuck", hoursAgo: 8, inReplyTo: "office-reply@house.ga.gov", body: "Thank you, the payment arrived this morning.\n\nOn Mon, Nov 9, 2026 at 3:14 PM Rep. Test <rep.test@house.ga.gov> wrote:\n> Dear Hal,\n> We have asked the Department of Labor to release your claim.\n> Please vote yes on HB 142 is not something I wrote." },
  { key: "forward-only", from: "Zoe Baird <zoe.baird@gmail.com>", subject: "Fwd: Property taxes are too high", hoursAgo: 48, body: "---------- Forwarded message ---------\nFrom: Tax Watch <alerts@taxwatch.example>\nSubject: Property taxes are too high\n\nTell your legislator to vote no on HB 7 and stop the homestead giveaway." },
  { key: "html-only", from: "Abe Cole <abe.cole@gmail.com>", subject: "Roads", hoursAgo: 47, html: "<div>Representative,</div><div><br></div><div>Please vote for HB 310. The <b>road maintenance</b> formula shortchanges growing counties like ours.</div><div><br></div><div>Abe Cole<br>5 Webb Bridge Way<br>Alpharetta, GA 30005</div>" },
  { key: "attachment", from: "Bea Dorn <bea.dorn@gmail.com>", subject: "Letter attached", hoursAgo: 46,
    body: "Please see my attached letter about the Early Literacy Coaches Act, which I hope you will support.\n\nBea Dorn",
    attachment: { name: "letter.pdf", type: "application/pdf", text: "%PDF-1.4 not a real pdf" } },
  { key: "external-tag", from: "Cal Eads <cal.eads@gmail.com>", subject: "[EXTERNAL] Medicaid", hoursAgo: 45,
    body: "I oppose SB 18. The state cannot afford to expand Medicaid right now.\n\nCal Eads" },
  { key: "out-of-state", from: "Dot Finn <dot.finn@gmail.com>", subject: "Georgia film credit", hoursAgo: 44,
    body: "I am writing from Texas to oppose HB 77.\n\nDot Finn\n900 Congress Avenue\nAustin, TX 78701" },

  { key: "office-reply", folder: "Sent", from: `Rep. Test <${OFFICE_ADDRESS}>`, to: "Hal Jones <hal.jones@gmail.com>", subject: "RE: Unemployment claim stuck",
    hoursAgo: 30, inReplyTo: "casework-ui@gmail.com",
    body: "Dear Hal,\n\nWe have asked the Department of Labor to release your claim and will follow up with them on Thursday.\n\nRep. Test" },
  { key: "unrelated-sent", folder: "Sent", from: `Rep. Test <${OFFICE_ADDRESS}>`, to: "friend@elsewhere.example", subject: "Dinner on Friday", hoursAgo: 29,
    body: "Private plans that have nothing to do with the office." },
];
