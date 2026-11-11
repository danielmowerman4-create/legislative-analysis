import * as chrono from "chrono-node";
import type { Evidence, MessageTypeKey, RequestedActionKey } from "./schema";
import { domainIn, domainOf } from "../email/sender-trust";
import { escapeRe } from "./issues";
import { sentences } from "./preprocess";
import { SELF_HARM } from "./urgency";

export { domainOf };

export type MessageEnvelope = {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  headers: Record<string, string>;
  labels: string[];
  direction: "inbound" | "outbound";
  sentAt: Date;
  viaPlatform?: boolean;
  namesWriter?: boolean;
};

export type OfficeRulesContext = {
  internalDomains: string[];
  legislatureDomains: string[];
  agencies: { name: string; abbreviation: string | null; domains: string[] }[];
  stateDomains?: string[];
};

export const FREEMAIL = new Set(
  "gmail.com googlemail.com yahoo.com ymail.com outlook.com hotmail.com live.com msn.com aol.com icloud.com me.com mac.com comcast.net att.net bellsouth.net sbcglobal.net verizon.net charter.net cox.net protonmail.com proton.me gmx.com mail.com zoho.com earthlink.net windstream.net".split(" "),
);

export const INHERITED_SUBJECT = /^\s*(?:re|fw|fwd|aw|wg)\s*(?:\[\d+\])?\s*:/i;

type TypeScore = { type: MessageTypeKey; confidence: number; signals: string[] };

export const SERVICE_ES = /\b(ayuda|ay[uú]denme|ay[uú]dame|necesito|puede\s+ayudarme|no\s+recibo|he\s+esperado|mi\s+(?:licencia|reclamo|solicitud|caso|beneficio))/i;
const ASKS_FOR_HELP = String.raw`help\s+(?:me|us|with)|need\s+(?:help|assistance)|can\s+(?:you|your\s+office|someone|anyone)\s+(?:please\s+)?(?:help|assist|look\s+into|step\s+in|intervene|do\s+(?:anything|something))|(?:is\s+there\s+)?(?:anyone|anybody|someone)\s+who\s+can\s+help|anything\s+(?:you|your\s+office)\s+can\s+do|assist(?:ance)?\s+with|intervene|step\s+in|look\s+into\s+(?:this|my)|who\s+(?:do|can|should)\s+i\s+(?:call|contact|talk\s+to|turn\s+to)|where\s+(?:do|can)\s+i\s+turn|(?:please\s+)?have\s+someone\s+(?:call|contact|reach)\s+me|need\s+(?:someone|somebody|your\s+office)\s+to|(?:could|can|would)\s+(?:you|someone|your\s+office)\s+(?:please\s+)?(?:check|find\s+out|follow\s+up)|look\s+at\s+this|get\s+(?:it|this)\s+(?:fixed|resolved|straightened\s+out)`;
const OWN_MATTER = String.raw`my\s+(?:claim|benefits|application|case|refund|license|appeal|check|payment)|(?:my|our)\s+(?:\w+['’]s\s+)?(?:\w+\s+){0,2}(?:claim|application|renewal|appeal|refund|permit|request|case\s+number)|case\s+(?:number|#)|claim\s+(?:number|#)`;
const IN_TROUBLE = String.raw`haven['’]t\s+(?:received|seen|gotten)|have\s+not\s+(?:received|seen|gotten)|(?:line|phone|call)\s+(?:disconnects|hangs\s+up|goes\s+to\s+voicemail)|no\s+one\s+picks\s+up|can['’]t\s+(?:get|reach)\s+(?:anyone|anybody|a\s+person|a\s+caseworker)|cannot\s+(?:get|reach)\s+(?:anyone|anybody|a\s+person|a\s+caseworker)|under\s+review\s+for|by\s+mistake|still\s+waiting|been\s+waiting|(?:has|have)\s+been\s+(?:pending|sitting)|pending\s+for|can['’]t\s+get\s+through|cannot\s+get\s+through|no\s+one\s+(?:answers|responds|has\s+responded|will\s+(?:call|answer))|nobody\s+(?:answers|responds|will\s+call)|never\s+heard\s+back|no\s+(?:response|reply|answer)\s+from|(?:second|third|fourth|fifth)\s+(?:email|letter|message|call|time\s+(?:writing|asking|calling))|keeps?\s+(?:losing|rejecting|denying|sending\s+me)|will\s+not\s+accept\s+my|won['’]t\s+accept\s+my|was\s+denied|been\s+denied|denial|appeal|backlog|stuck|on\s+hold\s+for|evict\w*|foreclos\w*|(?:has|have)\s+not\s+(?:been\s+)?processed|(?:hasn['’]t|haven['’]t)\s+(?:been\s+)?processed|nowhere\s+(?:else\s+)?to\s+(?:go|turn)|emergency\s+(?:rental\s+|housing\s+|food\s+)?assistance|(?:benefits|coverage|payments?)\s+(?:were|was|got|have\s+been|has\s+been)\s+(?:cut\s+off|stopped|terminated)`;
export const SERVICE = new RegExp(String.raw`\b(?:${ASKS_FOR_HELP}|${OWN_MATTER}|${IN_TROUBLE})\b`, "i");
export const MEETING = /\b(meet\s+with\s+(?:you|the\s+representative|the\s+senator)|meeting\s+with\s+(?:you|the\s+(?:representative|senator))|schedule\s+(?:a\s+)?(?:meeting|call|time)|set\s+up\s+a\s+(?:meeting|call)|would\s+(?:like|love)\s+to\s+meet|available\s+to\s+(?:meet|speak|join|attend)|meet\s+with\s+(?:us|our|me|my)|(?:join|attend|speak\s+at|come\s+to)\s+our|be\s+our\s+guest|visiting\s+the\s+capitol|capitol\s+(?:tour|visit)|say\s+hello\s+to|grab\s+(?:a\s+)?(?:coffee|lunch)|sit\s+down\s+with\s+you|(?:a\s+few|\d+)\s+minutes\s+of\s+your\s+time|request\s+(?:a|an)\s+(?:meeting|appointment)|visit\s+your\s+office|come\s+by\s+your\s+office|speak\s+(?:at|to\s+our)|invite\s+you\s+to|town\s+hall|availability\s+(?:for|to)|calendar)\b/i;
const POLICY_ES = /\b(apoyo|apoyamos|me\s+opongo|nos\s+oponemos|voten?\s+(?:a\s+favor|en\s+contra|que\s+s[ií]|que\s+no)|proyecto\s+de\s+ley|legislaci[oó]n|propuesta\s+de\s+ley)\b/i;
const POLICY = /\b(vote|voting|bill|legislation|law|support|oppose|urge|repeal|amend|as\s+your\s+constituent|i\s+am\s+writing\s+(?:to|about|in)|please\s+(?:support|oppose)|policy|funding|cuts?)\b/i;
const SPAM = /\b(crypto(?:currency)?\s+(?:opportunity|investment)|you\s+have\s+won|winner|wire\s+transfer|claim\s+your\s+prize|viagra|casino\s+bonus|seo\s+services|guest\s+post|backlinks|bitcoin\s+doubler|act\s+now|limited\s+time\s+offer)\b/i;
export const MEDIA = /\b(reporter\s+(?:with|for|at)|i(?:'m|\s+am)\s+a\s+(?:reporter|journalist|producer|editor)|on\s+deadline|for\s+(?:a|an|our)\s+(?:story|article|segment|piece)\s+(?:on|about)|request(?:ing)?\s+(?:a\s+|an\s+)?(?:comment|interview)|(?:do|give|sit\s+for|available\s+for|time\s+for)\s+(?:a\s+|an\s+)?(?:short\s+|brief\s+|quick\s+|on-camera\s+|phone\s+|live\s+)?interview|(?:doing|running|airing|writing|working\s+on)\s+(?:a|an)\s+(?:segment|story|article|piece|report)\b|comment\s+(?:by|before)\s+(?:deadline|\w+day)|press\s+inquiry|media\s+inquiry)\b/i;
const VENDOR = /\b(special\s+pricing|list\s+pricing|our\s+(?:platform|software|solution|product)\s+(?:can|helps?|offers?)|schedule\s+a\s+(?:quick\s+|free\s+)?demo|free\s+(?:trial|demo|consultation)|request\s+a\s+quote|limited[-\s]time\s+offer|we\s+(?:help|work\s+with)\s+(?:legislators|elected\s+officials|campaigns|legislative\s+offices))\b/i;
const LOBBYIST = /\b(registered\s+lobbyist|lobbyist\s+for|on\s+behalf\s+of\s+(?:our|the)\s+(?:members|clients?|organization|association)|government\s+(?:affairs|relations)|our\s+members\s+(?:urge|ask|support|oppose))\b/i;
const ORG_SIG = /\b(Association|Coalition|Foundation|Council|Chamber\s+of\s+Commerce|Alliance|Institute|Federation|Society|Inc\.|LLC|Executive\s+Director|Government\s+(?:Affairs|Relations)|Policy\s+Director|President\s+&\s+CEO|on\s+behalf\s+of\s+(?:the|our)\s+(?:members|organization))\b/;
const AUTO_FROM = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?|alerts?|news(?:letter)?|updates?|bounce|automated)[@+._-]/i;

export function classifyMessageType(
  env: MessageEnvelope, substantive: string, signature: string | null, office: OfficeRulesContext, hasBillRefs: boolean, issueCount: number,
): TypeScore[] {
  const h = Object.fromEntries(Object.entries(env.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  // A listed platform's domain and bulk-mail marks say nothing about the writer.
  const viaPlatform = env.viaPlatform === true;
  const domain = viaPlatform ? "" : domainOf(env.fromAddress);
  // When mail names a writer elsewhere, only a list header marks it a newsletter.
  const forSomeone = viaPlatform || env.namesWriter === true;
  const lists: Record<string, string> = viaPlatform ? {} : h;
  const bulk: Record<string, string> = forSomeone ? {} : h;
  const scores: TypeScore[] = [];
  const add = (type: MessageTypeKey, confidence: number, signal: string) => {
    const s = scores.find((x) => x.type === type);
    if (s) {
      s.confidence = Math.min(0.99, Math.max(s.confidence, confidence) + 0.03);
      s.signals.push(signal);
    } else scores.push({ type, confidence, signals: [signal] });
  };
  const inherited = INHERITED_SUBJECT.test(env.subject);
  const text = `${inherited ? "" : env.subject}\n${substantive}`;

  if (h["x-spam-flag"]?.toUpperCase() === "YES" || env.labels.includes("SPAM")) add("spam", 0.97, "provider marked as spam");
  else if (SPAM.test(text)) add("spam", 0.6, "spam phrases");

  if (lists["list-id"]) add("newsletter_automated", 0.95, "List-Id header");
  if (lists["list-unsubscribe"]) add("newsletter_automated", 0.9, "List-Unsubscribe header");
  if (/^list$/i.test(lists["precedence"] ?? "") || /^(bulk|junk)$/i.test(bulk["precedence"] ?? "")) add("newsletter_automated", 0.9, "Precedence: bulk");
  if (bulk["auto-submitted"] && bulk["auto-submitted"].toLowerCase() !== "no") add("newsletter_automated", 0.95, "Auto-Submitted header");
  const autoReply = h["x-autoreply"] || h["x-autorespond"] || /^(auto(matic)?\s*reply|out of (the )?office)/i.test(env.subject);
  if (autoReply) add("newsletter_automated", 0.92, "auto-reply");
  if (!forSomeone && AUTO_FROM.test(env.fromAddress)) add("newsletter_automated", 0.85, "no-reply sender");

  if (domainIn(domain, office.internalDomains)) add("legislative_staff", 0.93, "office domain");
  else if (domainIn(domain, office.legislatureDomains)) add("legislative_staff", 0.88, "legislature domain");

  const legislature = domainIn(domain, [...office.internalDomains, ...office.legislatureDomains]);
  const agency = office.agencies.find((a) => a.domains.length && domainIn(domain, a.domains));
  if (agency) add("government_agency", 0.92, `agency domain (${agency.abbreviation ?? agency.name})`);
  else if (domainIn(domain, office.stateDomains ?? []) && !legislature) add("government_agency", 0.9, "state government domain");
  else if (/\.(gov|mil)$/.test(domain) && !legislature) add("government_agency", 0.88, "government address");
  else if (/\.us$/.test(domain) && !legislature) add("government_agency", 0.75, ".us sender");

  const automated = scores.some((s) => s.type === "newsletter_automated" && s.confidence >= 0.85);
  const fromConstituentLike = FREEMAIL.has(domain) || (!automated && !scores.some((s) => s.type === "legislative_staff" || s.type === "government_agency"));

  if (!automated && fromConstituentLike) {
    if (SERVICE.test(text)) add("constituent_service", 0.8, "service request language");
    else if (SERVICE_ES.test(text)) add("constituent_service", 0.8, "service request language (Spanish)");
    const agencyMention = office.agencies.find((a) => new RegExp(agencyPattern(a)).test(text));
    if (agencyMention && SERVICE.test(text)) add("constituent_service", 0.86, `mentions ${agencyMention.abbreviation ?? agencyMention.name}`);
    if (MEETING.test(text)) add("meeting_request", 0.8, "meeting language");
    if (hasBillRefs) add("constituent_policy", 0.88, "bill reference");
    if (POLICY.test(text) && (issueCount > 0 || hasBillRefs)) add("constituent_policy", 0.82, "policy language with issue");
    else if (POLICY_ES.test(text)) add("constituent_policy", 0.82, "policy language (Spanish)");
    else if (POLICY.test(text)) add("constituent_policy", 0.6, "policy language");
    const typed = scores.some((x) => x.type === "constituent_policy" || x.type === "constituent_service" || x.type === "meeting_request");
    if (issueCount > 0 && !typed) add("constituent_policy", 0.82, "issue raised by constituent");
  }

  if (MEDIA.test(text)) {
    for (const s of scores) if (s.type === "constituent_policy" || s.type === "constituent_service") s.confidence = Math.min(s.confidence, 0.6);
    add("media", 0.93, "press language");
  }
  if (VENDOR.test(text)) {
    for (const s of scores) if (s.type === "constituent_policy" || s.type === "constituent_service") s.confidence = Math.min(s.confidence, 0.6);
    add("vendor", 0.9, "sales language");
  }
  if (LOBBYIST.test(`${text}\n${signature ?? ""}`)) add("advocacy_lobbyist", 0.93, "advocacy language");

  const orgSignature = ORG_SIG.test(`${signature ?? ""}\n${substantive.slice(-400)}`);
  if (!FREEMAIL.has(domain) && !automated && orgSignature) add("organization", 0.72, "organization signature");

  if (!scores.length) {
    if (FREEMAIL.has(domain) || viaPlatform) add("constituent_general", 0.8, "personal mail with no request");
    else add("other", 0.5, "no rule matched");
  }
  return scores.sort((a, b) => b.confidence - a.confidence);
}

const agencyPattern = (a: { name: string; abbreviation: string | null }) =>
  `\\b(${escapeRe(a.name)}${a.abbreviation ? `|${escapeRe(a.abbreviation)}` : ""})\\b`;

export function detectRequestedActions(substantive: string, types: MessageTypeKey[]): RequestedActionKey[] {
  const t = substantive;
  const out = new Set<RequestedActionKey>();
  if (types.includes("constituent_service")) out.add("agency_assistance");
  if (types.includes("meeting_request")) out.add("meeting");
  if (/\b(where\s+do\s+you\s+stand|what\s+is\s+your\s+position|how\s+(?:will|do)\s+you\s+(?:plan\s+to\s+)?vote|please\s+(?:respond|reply|let\s+me\s+know)|i\s+(?:would\s+)?(?:appreciate|expect)\s+a\s+(?:response|reply))\b/i.test(t)) out.add("policy_response");
  if (types.includes("constituent_policy") && /\b(please|urge|ask\s+you\s+to|vote)\b/i.test(t)) out.add("policy_response");
  if (/\b(what\s+is\s+the\s+status|status\s+of|more\s+information\s+(?:about|on)|can\s+you\s+(?:send|explain|tell)|how\s+(?:does|would)\s+(?:this|the)\s+bill|when\s+will\s+(?:the|this)\s+(?:bill|vote|hearing))\b/i.test(t)) out.add("legislation_info");
  if (/\b(follow\s+up|get\s+back\s+to\s+me|call\s+me|contact\s+me|reach\s+me\s+at|hear\s+back)\b/i.test(t)) out.add("follow_up");
  if (/\b(who\s+(?:should|do|can)\s+i\s+(?:contact|call|talk\s+to)|who\s+is\s+responsible|point\s+me\s+(?:to|in)|refer\s+me|which\s+(?:agency|office|department))\b/i.test(t)) out.add("referral");
  if (!out.size) out.add("none");
  return [...out];
}

const SENSITIVE: [string, RegExp][] = [
  ["health", /\b(diagnos\w+|cancer|chemo\w*|HIV|AIDS|dialysis|surgery|terminal(?:ly)?\s+ill|disabilit\w+|mental\s+health\s+crisis|psychiatric|overdose|pregnan\w+)\b/i],
  ["self_harm", SELF_HARM],
  ["immigration", /\b(visa|green\s+card|undocumented|deport\w*|asylum|USCIS|immigration\s+status|work\s+permit|DACA)\b/i],
  ["benefits_identifiers", /\b(social\s+security\s+(?:number|#)|SSN|medicaid\s+(?:id|number)|\d{3}-\d{2}-\d{4})\b/i],
  ["minors", /\b(foster\s+(?:child|care)|custody|DFCS|CPS|child\s+protective)\b|\bmy\s+(?:son|daughter|child|grandchild|grandson|granddaughter)(?:'s)?\b[^.!?]{0,80}\b(?:IEP|disabilit\w*|diagnos\w*|custody|abus\w*|juvenile|arrest\w*|hospital\w*|medicaid|benefits)/i],
  ["criminal", /\b(arrest\w*|probation|parole|convict\w*|incarcerat\w*|inmate|jail|warrant)\b/i],
  ["domestic_violence", /\b(domestic\s+violence|abus\w+|protective\s+order|restraining\s+order|stalk\w+)\b/i],
];

export function detectSensitive(substantive: string): string[] {
  return SENSITIVE.filter(([, re]) => re.test(substantive)).map(([k]) => k);
}

const CASE_CATEGORIES: [string, RegExp][] = [
  ["Unemployment insurance", /\b(unemployment|jobless|UI\s+claim|GDOL|department\s+of\s+labor|desempleo)\b/i],
  ["Driver services", /\b(driver'?s\s+license|DDS|DMV|license\s+(?:renewal|suspension|reinstatement)|vehicle\s+registration|tag\s+renewal|licencia\s+de\s+(?:conducir|manejar))\b/i],
  ["Medicaid and health coverage", /\b(medicaid|peachcare|health\s+coverage|DCH|seguro\s+m[eé]dico)\b/i],
  ["Food and family assistance", /\b(SNAP|food\s+stamps|EBT|WIC|DFCS|TANF|child\s+support|estampillas\s+de\s+comida|cupones\s+de\s+alimentos|manutenci[oó]n)\b/i],
  ["Taxes and refunds", /\b(tax\s+refund|state\s+refund|department\s+of\s+revenue|DOR|tax\s+lien|reembolso\s+de\s+impuestos)\b/i],
  ["Roads and infrastructure", /\b(pothole|road\s+repair|traffic\s+signal|GDOT|drainage|sidewalk)\b/i],
  ["Veterans services", /\b(veteran|VA\s+benefits|GDVS)\b/i],
  ["Corrections", /\b(inmate|prison|parole|probation|department\s+of\s+corrections)\b/i],
  ["Licensing and professional boards", /\b(professional\s+license|licensing\s+board|secretary\s+of\s+state|business\s+license)\b/i],
  ["Utilities", /\b(power\s+(?:bill|outage)|electric\s+bill|water\s+bill|utility)\b/i],
  ["Housing", /\b(evict\w*|landlord|housing\s+authority|section\s+8|rental\s+assistance|foreclos\w*|desalojo)\b/i],
];

export function suggestCase(types: MessageTypeKey[], substantive: string, agencies: OfficeRulesContext["agencies"]) {
  if (!types.includes("constituent_service")) return null;
  const category = CASE_CATEGORIES.find(([, re]) => re.test(substantive))?.[0] ?? "General assistance";
  const agency = agencies.find((a) => new RegExp(agencyPattern(a), "i").test(substantive));
  return { suggested: true, category, agency: agency?.name ?? null, reason: "Constituent asks for help with a government service." };
}

const COMMITMENT = /\b(?:i|we)(?:'ll|\s+will|\s+am\s+going\s+to|\s+are\s+going\s+to|\s+plan\s+to)\s+(?:reach\s+out|contact|call|follow\s+up|get\s+back|email|check|look\s+into|send|connect|forward|ask|speak|talk)\b[^.!?\n]*/gi;

type Commitment = { text: string; dueHint: string | null; due: Date | null; evidence: Evidence };

export function detectCommitments(substantive: string, sentAt: Date): Commitment[] {
  const out: Commitment[] = [];
  for (const m of substantive.matchAll(COMMITMENT)) {
    const text = m[0].trim();
    const parsed = chrono.parse(text, sentAt, { forwardDate: true })[0];
    const raw = m[0].trimEnd();
    const evidence: Evidence = { start: m.index!, end: m.index! + raw.length, text: raw, field: "substantive" };
    out.push({ text, dueHint: parsed?.text ?? null, due: parsed?.start.date() ?? null, evidence });
  }
  return out;
}

const TYPE_LABEL: Record<MessageTypeKey, string> = {
  constituent_policy: "Policy correspondence",
  constituent_service: "Service request",
  meeting_request: "Meeting request",
  constituent_general: "Constituent note",
  government_agency: "Agency correspondence",
  legislative_staff: "Legislative staff",
  organization: "Organization",
  newsletter_automated: "Newsletter or automated",
  media: "Press inquiry",
  vendor: "Vendor or sales",
  advocacy_lobbyist: "Advocacy or lobbyist",
  spam: "Spam",
  other: "Other",
};

const POSITION_VERB: Record<string, string> = {
  support: "supports", oppose: "opposes", mixed: "has mixed or conditional views on", neutral: "asks about", unclear: "mentions",
};

export function ruleSummary(input: {
  types: MessageTypeKey[];
  issueLabels: string[];
  positions: { label: string; position: string; confidence: number }[];
  actions: RequestedActionKey[];
  caseCategory: string | null;
  firstSentence: string;
  isForwardOnly: boolean;
  fromOffice?: boolean;
}) {
  const parts: string[] = [input.fromOffice ? "Sent by the office" : TYPE_LABEL[input.types[0]]];
  if (input.isForwardOnly) parts.push("Forwarded without comment");
  const clear = input.positions.filter((p) => p.position !== "unclear" && p.confidence >= 0.6);
  if (clear.length) parts.push(`Sender ${clear.map((p) => `${POSITION_VERB[p.position]} ${p.label}`).join("; ")}`);
  if (input.issueLabels.length) parts.push(`About ${input.issueLabels.slice(0, 3).join(", ")}`);
  if (input.caseCategory) parts.push(`Possible case: ${input.caseCategory}`);
  const acts = input.actions.filter((a) => a !== "none");
  if (acts.length) parts.push(`Requests ${acts.map((a) => a.replace(/_/g, " ")).join(", ")}`);
  let s = parts.join(". ") + ".";
  if (s.length < 60 && input.firstSentence) s += ` “${input.firstSentence.slice(0, 160)}${input.firstSentence.length > 160 ? "…" : ""}”`;
  return s.slice(0, 600);
}

const OPENER = String.raw`dear|hello|hi|hey|greetings|good\s+(?:morning|afternoon|evening)|buenos\s+d[ií]as|buenas\s+tardes|hola|representative|senator|rep\.?|sen\.?|mr\.?|ms\.?|mrs\.?|to\s+whom\s+it\s+may\s+concern`;
const GREETING = new RegExp(String.raw`^(?:(?:${OPENER})\b[^.!?\n]{0,45}[,:!]|(?:hello|hi|hey|greetings|hola|good\s+(?:morning|afternoon|evening)|buenos\s+d[ií]as|to\s+whom\s+it\s+may\s+concern))$`, "i");

export function firstSentence(text: string) {
  return sentences(text).find((s) => !GREETING.test(s.text.trim()))?.text ?? "";
}
