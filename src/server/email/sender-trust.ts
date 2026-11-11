import type { SenderTrust } from "../db/schema";
import { FREEMAIL } from "../classification/rules";

type Address = { address: string; name: string | null };

export type SenderRuleMatch = { matchType: "address" | "domain"; value: string };

export type SenderAssessment = {
  trust: Exclude<SenderTrust, "unknown">;
  detail: { spf: string | null; dkim: string | null; dmarc: string | null; reasons: string[] };
  // Whose record this may attach to; null until a person confirms one.
  identity: Address | null;
  // A Reply-To or relayed writer: shown to staff, never treated as proven.
  claimed: Address | null;
  isInternal: boolean;
};

const SERVICE_ADDRESS = /^(no-?reply|do-?not-?reply|donotreply|bounce|bounces|mailer|mailer-daemon|postmaster|notifications?|alerts?|reply\+|replies?\b|support|info)/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const BODY_LABEL = /^\s*(?:from|e-?mail|sender|constituent(?:\s+e-?mail)?|contact)\s*:\s*.*?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/im;

export const domainOf = (address: string) => address.toLowerCase().split("@")[1] ?? "";

const aligned = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
export const domainIn = (domain: string, list: string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

export function matchesSenderRule(address: string, rule: SenderRuleMatch) {
  const a = address.toLowerCase();
  const value = rule.value.toLowerCase();
  return rule.matchType === "address" ? a === value : domainIn(domainOf(a), [value]);
}

const ROLE_MAILBOX = /^(reply|replies|billing|sales|marketing|news|newsletters?|hello|contact|team|help|service|customer[a-z]*|feedback|orders?|receipts?|accounts?|members?|membership|events?|updates?|editor|subscriptions?|press|media|admin|webmaster)(?:[._+-].*|\d*)$/i;

function registeredName(domain: string) {
  const labels = domain.split(".");
  const twoPartEnding = labels.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(labels[labels.length - 2]);
  return (labels[labels.length - (twoPartEnding ? 3 : 2)] ?? "").replace(/[^a-z0-9]/g, "");
}

export function namesAnotherWriter(fromAddress: string, replyAddress: string | null, internalDomains: string[]) {
  const a = replyAddress?.trim().toLowerCase();
  if (!a || !EMAIL.test(a) || SERVICE_ADDRESS.test(a) || ROLE_MAILBOX.test(a.split("@")[0])) return false;
  const domain = domainOf(a);
  if (aligned(domain, domainOf(fromAddress)) || domainIn(domain, internalDomains)) return false;
  if (FREEMAIL.has(domain)) return true;
  const theirs = registeredName(domain);
  const senders = registeredName(domainOf(fromAddress));
  return theirs.length < 4 || senders.length < 4 || !(theirs.includes(senders) || senders.includes(theirs));
}

function stripComments(s: string) {
  let depth = 0;
  let out = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

export type AuthResults = {
  spf: string | null; spfDomain: string | null; dkim: string | null; dkimDomains: string[]; dmarc: string | null; headerFrom: string | null;
};

export type MailSource = { provider: "google" | "microsoft" | "imap"; imapHost?: string | null };

// Services whose results are signed under a name other than their IMAP host's.
const SIGNS_AS: Record<string, string> = {
  "imap.gmail.com": "google.com", "imap.mail.yahoo.com": "yahoo.com", "imap.aol.com": "yahoo.com", "imap.mail.me.com": "icloud.com",
  "imap.fastmail.com": "messagingengine.com", "imap.zoho.com": "zohomail.com",
};

// Anyone can write this header; only the mailbox service's own is evidence.
function writtenByService(header: string, source: MailSource) {
  const first = stripComments(header).split(";")[0].trim().toLowerCase();
  const name = first.includes("=") ? null : first.split(/\s+/)[0] || null;
  if (source.provider === "google") return name === "mx.google.com";
  // Microsoft writes its results without an authserv-id.
  if (source.provider === "microsoft") return name === null || /(^|\.)outlook\.com$/.test(name);
  const host = (source.imapHost ?? "").toLowerCase();
  const parent = host.split(".").slice(1);
  const domain = SIGNS_AS[host] ?? (parent.length >= 2 ? parent.join(".") : host);
  return Boolean(name && domain && (name === host || name === domain || name.endsWith(`.${domain}`)));
}

export function parseAuthenticationResults(header: string | null | undefined): AuthResults {
  const r: AuthResults = { spf: null, spfDomain: null, dkim: null, dkimDomains: [], dmarc: null, headerFrom: null };
  if (!header) return r;
  for (const part of stripComments(header).split(";")) {
    const m = part.trim().match(/^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    const prop = (name: string) => part.match(new RegExp(`${name}\\s*=\\s*([^\\s;]+)`, "i"))?.[1]?.toLowerCase() ?? null;
    if (method === "spf") {
      r.spf = result;
      r.spfDomain = prop("smtp\\.mailfrom")?.split("@").pop() ?? null;
    } else if (method === "dkim") {
      if (r.dkim !== "pass") r.dkim = result;
      if (result === "pass") {
        const d = prop("header\\.d") ?? prop("header\\.i")?.split("@").pop();
        if (d) r.dkimDomains.push(d);
      }
    } else {
      r.dmarc = result;
      r.headerFrom = prop("header\\.from");
    }
  }
  return r;
}

type SenderInput = { from: Address; replyTo: Address[]; headers: Record<string, string>; relayRules: SenderRuleMatch[]; internalDomains: string[] };

// Only for confirmed, office-listed platforms; whatever it finds stays a claim.
function writerBehindRelay(input: SenderInput & { body: string }): Address | null {
  const { from, replyTo, headers, body, relayRules, internalDomains } = input;
  const usable = (address: string | undefined | null) => {
    const a = address?.trim().toLowerCase();
    if (!a || !EMAIL.test(a) || SERVICE_ADDRESS.test(a)) return null;
    if (relayRules.some((r) => matchesSenderRule(a, r)) || domainIn(domainOf(a), internalDomains)) return null;
    return a;
  };
  // "Jane Doe via Platform" names the person when nothing else does.
  const displayName = from.name?.replace(/\s+(?:via|through|on behalf of)\s+.+$/i, "").trim() || null;
  const fromHeader = (key: string) => {
    const raw = headers[key];
    if (!raw) return null;
    const address = usable(raw.match(EMAIL)?.[0]);
    return address ? { address, name: raw.split("<")[0].replace(/["']/g, "").trim() || displayName } : null;
  };
  for (const r of replyTo) {
    const address = usable(r.address);
    if (address) return { address, name: r.name ?? displayName };
  }
  const header = fromHeader("x-original-from") ?? fromHeader("x-original-sender");
  if (header) return header;
  // Folded into the platform's own: jane=mail.example@platform.net
  const folded = from.address.split("@")[0].match(/^(.+?)=([a-z0-9.-]+\.[a-z]{2,})$/i);
  const foldedAddress = folded ? usable(`${folded[1]}@${folded[2]}`) : null;
  if (foldedAddress) return { address: foldedAddress, name: displayName };
  const labeled = usable(body.match(BODY_LABEL)?.[1]);
  if (labeled) return { address: labeled, name: displayName };
  const lastLines = body.split("\n").filter((l) => l.trim()).slice(-5).join("\n");
  const closing = usable(lastLines.match(EMAIL)?.[0]);
  return closing ? { address: closing, name: displayName } : null;
}

// Reply-To is written by the sender, so it never establishes identity.
export function assessSender(input: SenderInput & { body?: string; source?: MailSource | null }): SenderAssessment {
  const { from, replyTo, headers, relayRules, internalDomains, body = "", source } = input;
  const domain = domainOf(from.address);
  const results = headers["authentication-results"];
  // With no source (the demo office), the topmost results are read as they stand.
  const auth = parseAuthenticationResults(results && (!source || writtenByService(results, source)) ? results : null);
  // Exchange strips this from outside mail; other services pass it through.
  const exchangeInternal = source?.provider === "microsoft" && headers["x-ms-exchange-organization-authas"]?.toLowerCase() === "internal";
  const reasons: string[] = [];

  const dmarcOk = auth.dmarc === "pass" && (!auth.headerFrom || aligned(auth.headerFrom, domain));
  const dkimOk = auth.dkimDomains.some((d) => aligned(d, domain));
  const spfOk = auth.spf === "pass" && Boolean(auth.spfDomain && aligned(auth.spfDomain, domain));
  const failed = !exchangeInternal && (auth.dmarc === "fail" || (auth.spf === "fail" && auth.dkim !== "pass"));
  const confirmed = !failed && (exchangeInternal || dmarcOk || dkimOk || spfOk);
  const detail = { spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, reasons };

  const replyAddress = replyTo.find((r) => r.address.toLowerCase() !== from.address.toLowerCase()) ?? null;

  if (failed) {
    reasons.push("The mail server reported that this sender failed its checks, so the From address may be forged.");
    return { trust: "failed", detail, identity: null, claimed: replyAddress, isInternal: false };
  }
  if (!confirmed) {
    reasons.push("The mail server could not confirm who sent this.");
    return { trust: "unverified", detail, identity: null, claimed: replyAddress, isInternal: false };
  }

  const isInternal = domainIn(domain, internalDomains);
  if (relayRules.some((r) => matchesSenderRule(from.address, r))) {
    reasons.push(`Sent through ${domain}, an advocacy platform this office listed.`);
    const person = writerBehindRelay({ from, replyTo, headers, body, relayRules, internalDomains });
    reasons.push(
      person ? "The platform says it is writing for this person. That address has not been confirmed separately." : "The platform did not say who wrote this.",
    );
    return { trust: "relay", detail, identity: person, claimed: person, isInternal: false };
  }

  reasons.push("The mail server confirmed this sender.");
  if (replyAddress) reasons.push(`The Reply-To points somewhere else (${replyAddress.address}). This record stays with the confirmed sender.`);
  return { trust: "verified", detail, identity: from, claimed: replyAddress, isInternal };
}
