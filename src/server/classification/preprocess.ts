import { franc } from "franc-min";

export type Preprocessed = {
  // The sender's own new text; every evidence offset points into it.
  substantive: string;
  quoted: string | null;
  forwarded: string | null;
  signature: string | null;
  language: string | null;
  isForwardOnly: boolean;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

// A numeric entity outside Unicode's range is left as written; String.fromCodePoint would throw on it.
export const entityChar = (code: number, raw: string) =>
  code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : raw;

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (/^#x/i.test(e)) return entityChar(parseInt(e.slice(2), 16), m);
      if (e.startsWith("#")) return entityChar(parseInt(e.slice(1), 10), m);
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FORWARD_MARKERS = [/^-{2,}\s*Forwarded message\s*-{2,}/im, /^Begin forwarded message:/im, /^-{2,}\s*Original Message\s*-{2,}/im, /^_{5,}\s*$/m];
const REPLY_HEADER = /^(On\s.{0,240}?wrote:)\s*$/im;
const OUTLOOK_HEADER = /^From:\s.+\n(?:Sent|Date):\s.+\n(?:To|Subject):\s/im;
const SIGNATURE_DELIM = /^--\s?$/m;
const MOBILE_SIG = /^(Sent from my (iPhone|iPad|Android|Galaxy|mobile device|phone)|Get Outlook for (iOS|Android)|Sent from Yahoo Mail.*|Sent via .+)$/im;
const SIGN_OFF = /^(thanks|thank you|thanks again|many thanks|sincerely|respectfully|regards|best regards|kind regards|warm regards|best|warmly|cheers|gracias|atentamente|cordialmente|god bless|yours truly|with appreciation)[,.!]?\s*$/im;

const BANNER_OPENS = String.raw`originated\s+(?:from\s+)?outside|(?:from|sent\s+by)\s+an?\s+external\s+(?:sender|source|address|e-?mail)|external\s+(?:e-?mail|sender|message)|outside\s+(?:of\s+)?(?:the|your|our)\s+(?:organization|agency|network|company|house|senate|legislature|general\s+assembly)`;
const BANNER_GOES_ON = String.raw`${BANNER_OPENS}|do\s+not\s+click|unless\s+you\s+(?:recognize|trust|know|were\s+expecting)|content\s+is\s+safe|exercise\s+caution|use\s+caution|report\s+(?:this|suspicious)`;
// One sentence from the very top, around the telling words.
const sentenceWith = (words: string) => new RegExp(String.raw`^\s*(?:(?:[^.!?\n]|\n(?!\s*\n)){0,240}?)(?:${words})(?:[^.!?\n]|\n(?!\s*\n)){0,240}(?:[.!?]+["')\]*_-]*|(?=\n\s*\n)|$)`, "i");
const BANNER_FIRST = sentenceWith(BANNER_OPENS);
const BANNER_NEXT = sentenceWith(BANNER_GOES_ON);
const BANNER_TAG = /^\s*[\[(*_-]*\s*(?:external|ext\.?)(?:\s+(?:e-?mail|sender|message|mail))?\s*[\])*_:-]*\s*(?:\n|$)/i;

// Drops a mail system's "this email came from outside" warning from the top.
export function stripExternalBanner(text: string): string {
  let rest = text;
  for (let found = 0; found < 5; found++) {
    const m = BANNER_TAG.exec(rest) ?? (found ? BANNER_NEXT : BANNER_FIRST).exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  // A rule line under the warning goes too, but not "---- Forwarded message".
  return rest === text ? text : rest.replace(/^\s+/, "").replace(/^(?:[ \t]*[*_=~-]{3,}[ \t]*(?:\n|$))+/, "").replace(/^\s+/, "");
}

function firstIndex(text: string, patterns: RegExp[]): number {
  let min = -1;
  for (const p of patterns) {
    const m = p.exec(text);
    if (m && (min === -1 || m.index < min)) min = m.index;
  }
  return min;
}

function detectLanguage(text: string): string | null {
  if (text.replace(/\s/g, "").length < 25) return null;
  const code = franc(text, { minLength: 25 });
  const map: Record<string, string> = { eng: "en", spa: "es", vie: "vi", kor: "ko", cmn: "zh",
    fra: "fr", por: "pt", deu: "de", hat: "ht", arb: "ar", rus: "ru", tgl: "tl" };
  return code === "und" ? null : (map[code] ?? code);
}

export function preprocess(input: { bodyText?: string | null; bodyHtml?: string | null }): Preprocessed {
  let text = (input.bodyText && input.bodyText.trim() ? input.bodyText : input.bodyHtml ? htmlToText(input.bodyHtml) : "")
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ");

  text = stripExternalBanner(text);

  // Rejoin "On ... wrote:" reply headers that wrap onto a second line.
  text = text.replace(/^(On\s[^\n]{0,200})\n([^\n]{0,120}wrote:)\s*$/gim, "$1 $2");

  let forwarded: string | null = null;
  let quoted: string | null = null;

  const fwdAt = firstIndex(text, FORWARD_MARKERS);
  const replyAt = firstIndex(text, [REPLY_HEADER, OUTLOOK_HEADER]);
  const cutAt = [fwdAt, replyAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;

  let head = text;
  if (cutAt >= 0) {
    head = text.slice(0, cutAt);
    const tail = text.slice(cutAt);
    if (cutAt === fwdAt) forwarded = tail.trim();
    else quoted = tail.trim();
  }

  const lines = head.split("\n");
  const kept: string[] = [];
  const quotedLines: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) quotedLines.push(line.replace(/^\s*>\s?/, ""));
    else kept.push(line);
  }
  if (quotedLines.length) quoted = [quotedLines.join("\n"), quoted].filter(Boolean).join("\n");
  head = kept.join("\n");

  let signature: string | null = null;
  const sigAt = firstIndex(head, [SIGNATURE_DELIM, MOBILE_SIG]);
  if (sigAt >= 0) {
    signature = head.slice(sigAt).trim();
    head = head.slice(0, sigAt);
  }
  const signOff = SIGN_OFF.exec(head);
  if (signOff) {
    const after = head.slice(signOff.index + signOff[0].length);
    const afterLines = after.split("\n").filter((l) => l.trim());
    if (afterLines.length <= 7 && afterLines.every((l) => l.trim().length <= 80)) {
      signature = [after.trim(), signature].filter(Boolean).join("\n") || signature;
      head = head.slice(0, signOff.index);
    }
  }

  const substantive = head.replace(/\n{3,}/g, "\n\n").trim();
  return {
    substantive,
    quoted,
    forwarded,
    signature,
    language: detectLanguage(substantive || forwarded || ""),
    isForwardOnly: !substantive && Boolean(forwarded),
  };
}

export type Sentence = { text: string; start: number; end: number };

export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^.!?\n]+(?:[.!?]+(?!\d)|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 1) out.push({ text: trimmed, start: m.index + lead, end: m.index + lead + trimmed.length });
  }
  // Rejoin splits after "H.B.", "No." and the like, so references stay whole.
  const merged: Sentence[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && /\b(?:[A-Z]\.){1,3}$|\bNo\.$|\bSec\.$|\bvs\.$|\bMr\.$|\bMrs\.$|\bMs\.$|\bDr\.$|\bRep\.$|\bSen\.$/.test(prev.text)) {
      prev.text = text.slice(prev.start, s.end);
      prev.end = s.end;
    } else merged.push({ ...s });
  }
  return merged;
}

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const LONG_NUMBER = /\b\d{9,}\b/g;
const DOB = /\b(?:DOB|date of birth|born)\s*[:\-]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi;

export function maskForModel(text: string) {
  return text.replace(SSN, "[SSN]").replace(DOB, "[DOB]").replace(LONG_NUMBER, "[NUMBER]");
}
