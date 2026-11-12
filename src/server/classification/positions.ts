import type { Evidence, PositionKey } from "./schema";
import { sentences } from "./preprocess";

export type PositionTarget = {
  key: string;
  type: "bill" | "issue";
  issueKey: string | null;
  billReference: string | null;
  spans: Evidence[];
};

export type PositionResult = {
  target: PositionTarget;
  position: PositionKey;
  confidence: number;
  evidence: Evidence[];
  notes: string;
};

type CueKind =
  | "support" | "oppose" | "weak_support" | "weak_oppose" | "conditional" | "question" | "sarcasm" | "not_oppose" | "info" | "group_support" | "group_oppose"
  | "someones_vote";
type Cue = { kind: CueKind; start: number; end: number };

const R = (s: string) => new RegExp(s, "gi");
const URGE = String.raw`(?:please|kindly|(?:i|we)(?:['’]m|['’]re|\s+am|\s+are)\s+(?:asking|urging|begging|imploring|counting\s+on|writing\s+to\s+(?:ask|urge))\s+(?:that\s+)?you(?:\s+to)?|(?:i|we)\s+(?:ask|urge|beg|implore|need|want)\s+(?:that\s+)?you(?:\s+to)?|i\s+urge\s+you\s+to|we\s+urge\s+you\s+to|urges?\s+you\s+to|asks?\s+you\s+to|i\s+ask\s+you\s+to|i\s+encourage\s+you\s+to|encourages?\s+you\s+to|calls?\s+on\s+you\s+to|i\s+implore\s+you\s+to|i\s+hope\s+you\s+will|i\s+hope\s+you|i\s+ask\s+that\s+you|respectfully\s+(?:ask|request|urge)s?\s+(?:that\s+)?you(?:\s+to)?)`;

// "I oppose any cut to teacher pay" backs teacher pay; the stance is on the cut.
const UNDOING = /\b(cuts?|cutting|reduc(?:e|es|ing|tion|tions)|eliminat(?:e|es|ing|ion)|slash(?:es|ing)?|defund(?:s|ing)?|repeal(?:s|ing)?|freez(?:e|es|ing)|roll(?:ing)?\s+back|rollbacks?|tak(?:e|ing)\s+away|gut(?:s|ting)?|abolish(?:es|ing)?|end(?:ing)?)\b/i;

const ADV = String.raw`(?:(?:still|now|too|both|all|strongly|fully|really|also|do|did|definitely|absolutely|wholeheartedly|completely|firmly|truly|totally|certainly|adamantly|vehemently|enthusiastically|respectfully|very\s+much|\d+\s?(?:%|percent)|\w+ly)\s+){0,2}`;
const BE = String.raw`(?:['’]m|['’]re|\s+am|\s+are|\s+remain|\s+stand)`;
const NOT = String.raw`(?:do\s+not|don['’]t|did\s+not|didn['’]t|cannot|can\s+not|can['’]t|could\s+not|couldn['’]t|will\s+not|won['’]t|would\s+not|wouldn['’]t|never|no\s+longer|can\s+no\s+longer|refuse\s+to)`;
// Verbs that take a side only before a bill: "back HB 12", not "call me back".
const OBJECT = String.raw`(?=\s+(?:[HS]\.?\s?[BRJ]?\.?\s?\d|(?:house|senate)\s+(?:bill|resolution)\b|(?:this|the|that|it|these|those|any|all)\b))`;
const BILLISH = String.raw`(?:[HS]\.?\s?[BRJ]?\.?\s?\d|(?:house|senate)\s+(?:bill|resolution)|(?:this|the|that)\s+(?:bill|legislation|measure|proposal|act|resolution)\b|it\b)`;

const GLAD = String.raw`(?:thank\w*|grateful|appreciate\w*|glad|pleased|proud|happy|applaud\w*|commend\w*|relieved)`;
const SORRY = String.raw`(?:disappoint\w*|dismay\w*|upset|angry|anger\w*|appalled|ashamed|shame\w*|sadden\w*|sorry|frustrat\w*|outrage\w*|regret\w*|shocked|troubled)`;
const VOTED_FOR = String.raw`(?:vot(?:e|ed|ing)\s+(?:for|yes\s+on|in\s+favor\s+of)|(?:yes\s+)?vote\s+(?:for|in\s+favor\s+of)|support(?:ed|ing)?\s+(?:of\s+)?|sponsor(?:ed|ing|ship\s+of)|cosponsor(?:ed|ing))`;
const VOTED_AGAINST = String.raw`(?:vot(?:e|ed|ing)\s+(?:against|no\s+on)|(?:no\s+)?vote\s+against|oppos(?:ed|ing|ition\s+to))`;
const GROUP = String.raw`(?:association|coalition|council|chamber|union|federation|alliance|league|society|foundation|institute|network|club|pta|board|committee|organization|group|company|church|congregation|chapter|caucus|guild|bureau)`;
const DISBELIEF = String.raw`(?:can['’]?t|cannot|could\s?n['’]?t|could\s+not|hard\s+to)\s+believe`;
const OURS = String.raw`(?:our|my)\s+(?:members?|membership|organization|association|coalition|board|clients?|family|company|church|union|chapter|neighbors|household)`;

// Order matters: negated forms match first and mask the plain forms within.
const CUE_PATTERNS: [CueKind, RegExp][] = [
  ["sarcasm", R(String.raw`\byeah,?\s+right\b|\bthanks\s+for\s+nothing\b|\bjust\s+what\s+we\s+need\b|\bwhat\s+a\s+(?:great|brilliant|wonderful)\s+idea\b|\boh,?\s+(?:great|wonderful|perfect|sure)\b|(?:^|\s)/s\b|\bgreat\s+job\b[^.!?]{0,40}\b(?:ruin|destroy|cut|gut|wreck|fail)\w*`)],
  ["support", R(String.raw`\b${GLAD}\b[^.!?;]{0,60}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_FOR}|\b${SORRY}\b[^.!?;]{0,60}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_AGAINST}|\b(?:reconsider|drop|end|withdraw|rethink)\s+your\s+(?:opposition|no\s+vote|vote\s+against)\b`)],
  ["oppose", R(String.raw`\b${SORRY}\b[^.!?;]{0,60}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_FOR}|\b${GLAD}\b[^.!?;]{0,60}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_AGAINST}|\b(?:reconsider|drop|end|withdraw|rethink)\s+your\s+(?:support|yes\s+vote|vote\s+for|sponsorship|co-?sponsorship)\b`)],
  // "I can't believe you voted against it" is most often dismay, so it only suggests a side.
  ["weak_support", R(String.raw`\b${DISBELIEF}\b[^.!?;]{0,30}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_AGAINST}`)],
  ["weak_oppose", R(String.raw`\b${DISBELIEF}\b[^.!?;]{0,30}?\b(?:you|your)\b[^.!?;]{0,25}?${VOTED_FOR}`)],
  ["someones_vote", R(String.raw`\b(?:i|we)\s+(?:wrote|emailed|called|said|was|were|used\s+to\s+be|had\s+been|once)\s+[^.!?;]{0,30}?\b(?:against|in\s+favor\s+of|opposed\s+to|in\s+support\s+of|a\s+supporter|an\s+opponent)\b|\b(?:you|your|he|she|they|his|her|their)\b[^.!?;]{0,25}?\b(?:voted|vote[ds]?\s+(?:last|in\s+committee|on\s+the\s+floor)|voting\s+record)\b[^.!?;]{0,15}?\b(?:for|against|yes|no)\b|\b(?:you|he|she|they)\s+voted\s+(?:for|against|yes|no)\b|\byour\s+(?:stance|position|vote)\s+on\b`)],
  ["support", R(String.raw`\b(?:do\s+not|don['’]t)\s+let\s+[^.!?;]{0,40}?\b(?:die|fail|stall|be\s+(?:killed|tabled|gutted|watered\s+down))\b|\b(?:please\s+)?(?:do\s+not|don['’]t)\s+(?:vote\s+against|vote\s+no\s+on|kill|block|veto|gut|weaken)\b`)],
  ["oppose", R(String.raw`\b${NOT}\s+(?:(?:ever|really|fully|possibly|honestly|simply|in\s+good\s+conscience)\s+)?(?:support|endorse|favor|get\s+behind|vote\s+for|vote\s+yes|back${OBJECT})\b|\bnot\s+in\s+(?:support|favor)\b|\b(?:do\s+not|don['’]t)\s+(?:approve|fund|(?:pass|advance)${OBJECT})\b|\b(?:should|must|ought)\s+not\s+(?:pass|become\s+law|be\s+passed|advance|move\s+forward)\b|\bshouldn['’]t\s+(?:pass|become\s+law|be\s+passed)\b`)],
  ["not_oppose", R(String.raw`\b(?:do\s+not|don['’]t|no\s+longer)\s+oppose\b`)],
  ["info", R(String.raw`\b(?:discuss|talk\s+(?:about|with\s+you\s+about)|learn\s+more\s+about|more\s+information\s+(?:about|on)|status\s+of|testify|update\s+(?:on|about))\b`)],
  ["conditional", R(String.raw`\bonly\s+if\b|\bunless\b|\bas\s+long\s+as\b|\bprovided\s+(?:that\s+)?(?:it|they|the)\b|\bif\s+(?:it|they|the\s+bill)\s+(?:is\s+|are\s+|were\s+)?(?:amended|changed|revised|fixed)\b|\bwith\s+(?:some\s+|the\s+)?(?:amendments?|changes)\b|\bhave\s+(?:some\s+|serious\s+|real\s+|a\s+few\s+)?(?:reservations|concerns)\b|\b(?:like|support|agree\s+with|appreciate|share)\s+the\s+(?:goals?|intent|idea|spirit|aims?|purpose|concept)\b|\bin\s+principle\b|\bas\s+(?:currently\s+|presently\s+)?written\b|\bin\s+its\s+(?:current|present)\s+form\b|\buntil\b[^.!?;]{0,60}?\b(?:fixed|changed|amended|addressed|removed|added|resolved|included|restored)\b|\ba\s+good\s+(?:start|first\s+step)\b|\bcould\s+(?:live\s+with|support|accept|get\s+behind|vote\s+for)\b|\b(?:please\s+|should\s+|must\s+|needs?\s+to\s+)(?:amend|fix|change|revise)\b|\bshould\s+be\s+(?:amended|fixed|changed|revised)\b|\bif\b[^.!?;]{0,60}?\b(?:were|was|is|are|gets?|got)\s+(?:capped|amended|changed|removed|added|fixed|limited|included|exempted|dropped|restored|raised|lowered)\b`)],
  [
    "support",
    R(
      [
        String.raw`\b(?:i|we)\s+${ADV}(?:support|favor|endorse|approve\s+of|applaud|back${OBJECT})\b`,
        String.raw`\b(?:i|we)${BE}\s+${ADV}(?:in\s+favor\b(?:\s+of)?|supportive\s+of|(?:all\s+)?for(?=\s+(?:${BILLISH})))`,
        String.raw`\b(?:i|we)${BE}\s+writing\s+(?:[^.!?;]{0,60}?\s)?(?:to\s+${ADV}support|in\s+${ADV}support)\b`,
        String.raw`\bwriting\b[^.!?;]{0,60}?\bto\s+${ADV}support\b`,
        String.raw`\bin\s+(?:strong\s+|full\s+|firm\s+)?support\s+of\b|\bin\s+favor\s+of\b`,
        String.raw`\b${URGE}\s+(?:\w+\s+){0,2}?(?:support|vote\s+(?:yes|for|in\s+favor|aye)|co-?sponsor|sign\s+on|approve|champion|fund|(?:pass|back|advance)${OBJECT})\b`,
        String.raw`\bvot(?:e|ing)\s+(?:yes|for|in\s+favor|aye)\b|\b(?:a|your|the)\s+(?:yes|aye|favorable)\s+vote\b|\byes\s+(?:on|to|for)\s+(?=${BILLISH})`,
        String.raw`\bpass\s+(?=${BILLISH})|\b(?:needs?|ought|has|have)\s+to\s+(?:pass|be\s+passed|become\s+law)\b|\b(?:should|must)\s+(?:pass|be\s+passed|become\s+law|move\s+forward|advance)\b`,
        String.raw`\bdeserves?\s+(?:\w+\s+){0,2}?(?:support|passage|vote)\b|\b(?:has|have)\s+(?:my|our)\s+(?:full\s+|strong\s+|complete\s+)?support\b`,
        String.raw`\bcount\s+(?:me|us)\s+(?:in\b|as\s+(?:a\s+)?(?:yes|supporter|in\s+favor)|among\s+(?:the\s+|those\s+)?support\w+)`,
        String.raw`\b${URGE}\s+(?:\w+\s+){0,2}?(?:get|stand|be)\s+behind\b|\b(?:i|we)${BE}\s+${ADV}behind${OBJECT}|\byour\s+(?:full\s+|strong\s+|continued\s+)?support\s+(?:for|of|on)\b|\b(?:need|ask\s+for|count\s+on|hope\s+for)\s+your\s+(?:support|yes\s+vote|vote)\b`,
        String.raw`\b${OURS}\s+${ADV}(?:supports?|backs?|endorses?|favors?)\b`,
        String.raw`\b(?:love|like|want|hope|need)\s+to\s+see\s+[^.!?;]{0,40}?\b(?:pass(?:ed|es)?|become\s+law|signed)\b|\bhop(?:e|ing)\s+(?:that\s+)?[^.!?;]{0,40}?\b(?:passes|becomes\s+law|gets\s+(?:passed|a\s+yes))\b|\b(?:gets?|has|have)\s+my\s+(?:vote|backing)\b`,
        String.raw`\b(?:would|will|could|can)\s+you\s+(?:please\s+)?(?:consider\s+)?(?:sign(?:ing)?\s+on|co-?sponsor(?:ing)?|support(?:ing)?|back(?:ing)?${OBJECT}|vot(?:e|ing)\s+(?:for|yes))\b`,
        String.raw`\badd\s+(?:my|our)\s+names?\s+to\s+[^.!?;]{0,40}?\b(?:support\w*|in\s+favor|backing)\b`,
        String.raw`\bthank\s+you\s+for\s+(?:supporting|sponsoring|co-?sponsoring|introducing|voting\s+(?:for|yes\s+on)|championing|backing|your\s+(?:support|yes\s+vote|vote\s+for))\b`,
        String.raw`\bsupporter\s+of\b|\b(?:voice|express|register|state|share|offer|lend)\s+(?:my|our)\s+(?:strong\s+|full\s+)?support\s+(?:for|of|to)\b|\b(?:my|our)\s+(?:strong\s+|full\s+)?support\s+for\b`,
        String.raw`^(?:and\s+|so\s+|instead,?\s+)?(?:please\s+)?(?:support|pass|back|co-?sponsor|approve)\s+(?=${BILLISH})`,
        String.raw`\b(?:hop(?:e|ing)|trust|pray(?:ing)?)\s+(?:that\s+)?[^.!?;]{0,40}?\b(?:has|gets|earns|wins|will\s+(?:have|get|earn|win))\s+your\s+(?:full\s+|strong\s+)?(?:vote|support|yes\s+vote|backing)\b`,
        String.raw`\b(?:i|we)\s+${ADV}urge\s+(?:the\s+)?(?:\w+\s+)?(?:passage|adoption|approval|enactment)\b`,
        String.raw`\b(?:apoyo|apoyamos|estoy\s+a\s+favor|estamos\s+a\s+favor|voten?\s+(?:a\s+favor|que\s+s[ií]))\b`,
      ].join("|"),
    ),
  ],
  [
    "oppose",
    R(
      [
        String.raw`\b(?:i|we)\s+${ADV}(?:oppose|object\s+to|reject|disapprove\s+of)\b`,
        String.raw`\b(?:i|we)${BE}\s+${ADV}(?:opposed\b(?:\s+to)?|against|not\s+for(?=\s+(?:${BILLISH})))`,
        String.raw`\b(?:i|we)${BE}\s+writing\s+(?:[^.!?;]{0,60}?\s)?(?:to\s+${ADV}oppose|in\s+${ADV}opposition)\b`,
        String.raw`\bwriting\b[^.!?;]{0,60}?\bto\s+${ADV}oppose\b`,
        String.raw`\bin\s+(?:strong\s+|firm\s+)?opposition\s+to\b`,
        String.raw`\b${URGE}\s+(?:\w+\s+){0,2}?(?:oppose|reject|vote\s+(?:no|against|nay|down)|veto|defeat|(?:kill|stop|block|withdraw|drop|scrap)${OBJECT})\b`,
        String.raw`\bvot(?:e|ing)\s+(?:no|against|nay)\b|\bvote\s+(?:it|this|that)\s+down\b|\b(?:a|your|the)\s+(?:no|nay)\s+vote\b|\bno\s+(?:on|to)\s+(?=${BILLISH})`,
        String.raw`\bkill\s+(?:this|the)\s+(?:bill|legislation)\b|\b(?:must|needs?\s+to|has\s+to|should)\s+be\s+(?:stopped|defeated|rejected|killed|voted\s+down)\b`,
        String.raw`\bcount\s+(?:me|us)\s+(?:out\b|as\s+(?:a\s+)?(?:no|opposed|against|opponent))`,
        String.raw`\b${OURS}\s+${ADV}(?:opposes?|objects?\s+to|rejects?|(?:is|are)\s+(?:opposed\s+to|against))\b|\b(?:need|ask\s+for|count\s+on|hope\s+for)\s+your\s+(?:no\s+vote|opposition)\b`,
        String.raw`\b(?:love|like|want|hope|need)\s+to\s+see\s+[^.!?;]{0,40}?\b(?:fail|die|defeated|stopped|killed|vetoed|voted\s+down)\b|\bhop(?:e|ing)\s+(?:that\s+)?[^.!?;]{0,40}?\b(?:fails|dies|is\s+(?:defeated|stopped|killed)|gets\s+(?:voted\s+down|a\s+no))\b`,
        String.raw`\b(?:would|will|could|can)\s+you\s+(?:please\s+)?(?:consider\s+)?(?:oppos(?:e|ing)|vot(?:e|ing)\s+(?:against|no))\b`,
        String.raw`\badd\s+(?:my|our)\s+names?\s+to\s+[^.!?;]{0,40}?\b(?:oppos\w*|against)\b`,
        String.raw`\bthank\s+you\s+for\s+(?:opposing|voting\s+(?:against|no\s+on)|standing\s+against|fighting|your\s+(?:opposition|no\s+vote|vote\s+against))\b`,
        String.raw`\bopponent\s+of\b|\b(?:voice|express|register|state|share)\s+(?:my|our)\s+(?:strong\s+)?opposition\s+to\b|\b(?:my|our)\s+(?:strong\s+)?opposition\s+to\b`,
        String.raw`^(?:and\s+|so\s+)?(?:please\s+)?(?:oppose|reject|defeat|kill|block|veto|stop)\s+(?=${BILLISH})`,
        String.raw`\b(?:hop(?:e|ing)|trust|pray(?:ing)?)\s+(?:that\s+)?[^.!?;]{0,40}?\b(?:has|gets|earns|will\s+(?:have|get|earn))\s+your\s+(?:no\s+vote|opposition)\b`,
        String.raw`\b(?:i|we)\s+${ADV}urge\s+(?:the\s+)?(?:\w+\s+)?(?:defeat|rejection)\b`,
        String.raw`\b(?:me\s+opongo|nos\s+oponemos|estoy\s+en\s+contra|estamos\s+en\s+contra|voten?\s+(?:en\s+contra|que\s+no))\b`,
      ].join("|"),
    ),
  ],
  ["group_support", R(String.raw`\b${GROUP}\b[^.!?;]{0,60}?\b(?:supports|endorses|backs|favors|is\s+in\s+favor\s+of|urges\s+(?:passage|a\s+yes\s+vote))\b|\burges\s+(?:the\s+)?(?:\w+\s+)?(?:passage|adoption|approval|enactment)\s+of\b`)],
  ["group_oppose", R(String.raw`\b${GROUP}\b[^.!?;]{0,60}?\b(?:opposes|objects\s+to|rejects|is\s+(?:opposed\s+to|against)|urges\s+(?:defeat|a\s+no\s+vote))\b|\burges\s+(?:the\s+)?(?:\w+\s+)?(?:defeat|rejection)\s+of\b`)],
  ["weak_support", R(String.raw`\b(?:disappointed|sad|upset|frustrated)\s+(?:that\s+)?[^.!?]{0,60}\b(?:failed|died|was\s+defeated|did\s+not\s+pass|didn't\s+pass|was\s+vetoed)\b|\bwe\s+need\s+(?:this|more)\b|\bincrease\s+(?:funding|pay|salaries)\b|\bfully\s+fund\b|\bgood\s+(?:bill|idea|legislation)\b|\bmuch\s+needed\b|\bstep\s+in\s+the\s+right\s+direction\b|\bworth\s+(?:passing|supporting|a\s+yes)\b|\b(?:is|would\s+be|will\s+be)\s+(?:a\s+)?(?:good|great|right|needed|necessary|overdue)\s+(?:for|thing|move|step|law)\b|\b(?:would|will)\s+(?:really\s+)?(?:help|protect|save|benefit)\b|\b(?:can['’]?t|cannot|could\s?n['’]?t|could\s+not)\s+(?:come|pass|happen|get\s+here|be\s+signed)\s+(?:soon|fast|quickly)\s+enough\b|\b(?:is|are|was)\s+(?:long|way|far|years|decades)\s+overdue\b`)],
  ["weak_oppose", R(String.raw`\b(?:glad|relieved|happy|pleased)\s+(?:that\s+)?[^.!?]{0,60}\b(?:failed|died|was\s+defeated|did\s+not\s+pass|was\s+vetoed)\b|\b(?:terrible|harmful|dangerous|disastrous|awful|unconstitutional|misguided|reckless|devastating)\b|\bbad\s+(?:bill|idea|policy)\b|\bagainst\b|\brepeal\b|\bstop\s+(?:the|this)\b|\b(?:is|would\s+be|will\s+be)\s+(?:a\s+)?(?:bad|wrong|mistake|disaster|unfair|unnecessary|waste)\b|\b(?:would\s+|will\s+)?(?:hurt|harm|punish|devastate|bankrupt|endanger)s?\b|\b(?:(?:has|needs|ought|got)\s+to|must)\s+go(?=\s*(?:[.!,;]|$|away\b|now\b))`)],
];

const REPORTED_SPEECH = /^(?:some\s+(?:people\s+)?(?:say|claim|argue|think)|supporters\s+(?:say|claim|argue)|proponents\s+(?:say|claim|argue)|opponents\s+(?:say|claim|argue)|critics\s+(?:say|claim|argue)|they\s+(?:say|claim)|the\s+(?:sponsor|author|bill's\s+sponsor)\s+(?:says|said|claims)|according\s+to|i(?:'ve|\s+have)\s+heard|my\s+(?:neighbor|friend|husband|wife)\s+(?:says|thinks))\b/i;
const COREF = /\b(this\s+bill|the\s+bill|this\s+legislation|the\s+legislation|this\s+measure|the\s+measure|this\s+proposal|the\s+proposal|it)\b/i;

type Clause = { start: number; end: number; text: string; sentenceStart: number; sentenceEnd: number; reported: boolean; question: boolean };

function quotedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/[“"]([^”"]{12,}?)[”"]/g)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  for (const s of sentences(text)) {
    const reported = REPORTED_SPEECH.test(s.text);
    const question = s.text.trim().endsWith("?");
    const splitter = /;|\s+(?:but|however|while|whereas|although|though|yet)\s+|,\s+and\s+(?=(?:i|we|please|vote|oppose|support|strongly|urge)\b)|\s+and\s+(?=(?:oppose|support|vote|urge|reject)\b)/gi;
    let last = 0;
    let m: RegExpExecArray | null;
    const pieces: [number, number][] = [];
    while ((m = splitter.exec(s.text))) {
      pieces.push([last, m.index]);
      last = m.index + m[0].length;
    }
    pieces.push([last, s.text.length]);
    for (const [a, b] of pieces) {
      const raw = s.text.slice(a, b);
      const lead = raw.length - raw.trimStart().length;
      const t = raw.trim();
      if (!t) continue;
      out.push({ start: s.start + a + lead, end: s.start + a + lead + t.length, text: t, sentenceStart: s.start, sentenceEnd: s.end, reported, question });
    }
  }
  return out;
}

function cuesIn(text: string, offset: number, excluded: [number, number][]): Cue[] {
  const cues: Cue[] = [];
  const masked: [number, number][] = [];
  for (const [kind, re] of CUE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = offset + m.index!;
      const end = start + m[0].length;
      if (excluded.some(([a, b]) => start >= a && end <= b)) continue;
      if (masked.some(([a, b]) => start < b && end > a)) continue;
      cues.push({ kind, start, end });
      masked.push([start, end]);
    }
  }
  return cues;
}

// Words around a side taken on nothing in particular: "So please vote no today."
const ENDS = String.raw`please|thanks|thank\s+you|today|now|again|tomorrow|(?:on\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|this\s+(?:week|session|year|time)|for\s+(?:us|me)|when\s+it\s+comes\s+(?:up|to\s+(?:a\s+vote|the\s+floor))|in\s+committee|on\s+the\s+floor`;
const STARTS = "so|and|then|again|please|instead";
const POINTS = String.raw`(?:on\s+)?(?:this|that)(?:\s+one)?`;
const onlyWords = (words: string) => new RegExp(String.raw`^(?:[\s,.!?…-]|\b(?:${words})\b)*$`, "i");
const NO_OBJECT = onlyWords(ENDS);
const POINTS_BACK = onlyWords(`${ENDS}|${POINTS}`);
const LEADS_IN = onlyWords(STARTS);
const POINTS_FORWARD = onlyWords(`${STARTS}|${POINTS}`);
const VOTE_ASK = /\bvot(?:e|ing)\s+(?:yes|no|for|against|in\s+favor|aye|nay|(?:it|this|that)\s+down)\b|\b(?:yes|no|aye|nay)\s+vote\b/i;

// "Vote yes." and "I am opposed." name nothing (plain); "I am against that." points at the sentence before.
function sideWithNoObject(c: Clause, cues: Cue[]): "plain" | "pointing" | null {
  let found: "pointing" | null = null;
  for (const cue of cues) {
    if (cue.kind !== "support" && cue.kind !== "oppose") continue;
    const before = c.text.slice(0, cue.start - c.start);
    const after = c.text.slice(cue.end - c.start);
    if (VOTE_ASK.test(c.text.slice(cue.start - c.start, cue.end - c.start)) && POINTS_BACK.test(after)) return "plain";
    if (NO_OBJECT.test(after) && LEADS_IN.test(before)) return "plain";
    if (POINTS_BACK.test(after) && POINTS_FORWARD.test(before)) found = "pointing";
  }
  return found;
}

const STANCE = new Set<CueKind>(["support", "oppose", "weak_support", "weak_oppose", "not_oppose", "group_support", "group_oppose"]);
const within = (e: Evidence, c: { start: number; end: number }) => e.field !== "subject" && e.start >= c.start && e.end <= c.end;

export function detectPositions(substantive: string, targets: PositionTarget[]): PositionResult[] {
  const cls = clauses(substantive);
  const excluded = quotedRanges(substantive);
  const bills = targets.filter((t) => t.type === "bill");
  const perTarget = new Map<string, { cues: (Cue & { attributed: boolean })[]; evidence: Evidence[]; questions: Evidence[] }>();
  for (const t of targets) perTarget.set(t.key, { cues: [], evidence: [], questions: [] });
  const sentenceEnds = new Map(cls.map((x) => [x.sentenceStart, x.sentenceEnd]));
  const starts = [...sentenceEnds.keys()];
  const namedJustBefore = (t: PositionTarget, c: Clause) => {
    const start = starts[starts.indexOf(c.sentenceStart) - 1];
    return start !== undefined && t.spans.some((s) => within(s, { start, end: sentenceEnds.get(start)! }));
  };
  // A bill the letter only asks about: "I oppose the parking fees" elsewhere is not about it.
  const onlyAsked = (t: PositionTarget) => {
    const naming = cls.filter((x) => t.spans.some((s) => within(s, x)));
    return t.type === "bill" && naming.length > 0 && naming.every((x) => x.question);
  };

  for (const c of cls) {
    if (c.reported) continue;
    const cues = cuesIn(c.text, c.start, excluded);
    const ev: Evidence = { start: c.start, end: c.end, text: c.text, field: "substantive" };
    let inClause = targets.filter((t) => t.spans.some((s) => within(s, c)));
    let attributed = false;
    if (c.question && !cues.length && bills.length === 1 && COREF.test(c.text) && !inClause.some((t) => t.type === "bill")) {
      perTarget.get(bills[0].key)!.questions.push(ev);
      if (!inClause.length) continue;
    }
    if (!inClause.length && cues.length) {
      const inSentence = targets.filter((t) => t.spans.some((s) => within(s, { start: c.sentenceStart, end: c.sentenceEnd })));
      // A side with no object goes to the letter's only bill: "HB 95 is long overdue. Vote yes."
      const bare = bills.length === 1 ? sideWithNoObject(c, cues) : null;
      const toTheBill = bare === "plain" || (bare === "pointing" && namedJustBefore(bills[0], c));
      const explicit = cues.some((cue) => cue.kind === "support" || cue.kind === "oppose");
      if (inSentence.length === 1) inClause = inSentence;
      else if (bills.length === 1 && COREF.test(c.text)) inClause = bills;
      else if (targets.length === 1 && (toTheBill || !explicit || !onlyAsked(targets[0]))) inClause = targets;
      else if (toTheBill) inClause = bills;
      attributed = inClause.length > 0;
    }
    if (inClause.length > 1 && inClause.some((t) => t.type === "bill")) {
      const issueOnly = inClause.filter((t) => t.type === "issue");
      inClause = inClause.filter((t) => t.type === "bill");
      for (const t of issueOnly) {
        const rec = perTarget.get(t.key)!;
        rec.cues.push(...cues.map((cue) => ({ ...cue, attributed: true })));
        if (cues.length) rec.evidence.push(ev);
      }
    }
    // "Yes on HB 1, no on SB 2": a stance goes to the next bill named, or the nearest.
    const billsHere = inClause.filter((t) => t.type === "bill");
    const sides = cues.filter((cue) => STANCE.has(cue.kind));
    const directed = billsHere.length > 1 && sides.length > 1;
    const about = (cue: Cue) => {
      const marks = billsHere.flatMap((t) =>
        t.spans.filter((sp) => within(sp, c)).map((sp) => ({ t, gap: sp.start >= cue.end ? sp.start - cue.end : 10_000 + (cue.start - sp.end) })),
      );
      return marks.sort((x, y) => x.gap - y.gap)[0]?.t;
    };
    for (const t of inClause) {
      const rec = perTarget.get(t.key)!;
      const own = directed && t.type === "bill" ? cues.filter((cue) => !STANCE.has(cue.kind) || about(cue) === t) : cues;
      rec.cues.push(...own.map((cue) => ({ ...cue, attributed })));
      if (own.length) rec.evidence.push(ev);
      if (c.question) rec.questions.push(ev);
    }
  }

  return targets.map((target) => {
    const rec = perTarget.get(target.key)!;
    const cues = target.type === "issue" ? rec.cues.filter((c) => c.kind !== "weak_oppose" && c.kind !== "weak_support") : rec.cues;
    const { evidence, questions } = rec;
    const has = (k: CueKind) => cues.some((c) => c.kind === k);
    const n = (k: CueKind) => cues.filter((c) => c.kind === k).length;
    const penalty = cues.length && cues.every((c) => c.attributed) ? 0.08 : 0;
    const ev = dedupe(evidence).slice(0, 3);
    let position: PositionKey = "unclear";
    let confidence = 0.5;
    let notes = "No explicit stance found for this target.";

    const sup = n("support");
    const opp = n("oppose");
    const weakSup = n("weak_support");
    const weakOpp = n("weak_oppose");

    if (has("sarcasm")) {
      position = "unclear";
      confidence = 0.35;
      notes = "Possible sarcasm; stance cannot be read literally.";
    } else if (has("conditional") && (sup || opp || weakSup || weakOpp)) {
      position = "mixed";
      confidence = 0.78;
      notes = "Stance depends on conditions or changes.";
    } else if (sup && opp) {
      position = "mixed";
      confidence = 0.62;
      notes = "Both support and opposition language for the same target.";
    } else if (sup) {
      position = "support";
      confidence = Math.min(0.96, 0.9 + 0.03 * Math.min(sup - 1, 2) - (weakOpp ? 0.1 : 0));
      notes = "Explicit support language.";
    } else if (opp) {
      position = "oppose";
      confidence = Math.min(0.96, 0.9 + 0.03 * Math.min(opp - 1, 2) - (weakSup ? 0.1 : 0));
      notes = "Explicit opposition language.";
    } else if (n("group_support") && !n("group_oppose")) {
      position = "support";
      confidence = 0.8;
      notes = "A group's support, stated in the third person. Check that the sender speaks for it.";
    } else if (n("group_oppose") && !n("group_support")) {
      position = "oppose";
      confidence = 0.8;
      notes = "A group's opposition, stated in the third person. Check that the sender speaks for it.";
    } else if (has("not_oppose")) {
      position = "neutral";
      confidence = 0.6;
      notes = "States non-opposition without stated support.";
    } else if (weakSup && !weakOpp) {
      position = "support";
      confidence = 0.66;
      notes = "Only indirect support language.";
    } else if (weakOpp && !weakSup) {
      position = "oppose";
      confidence = 0.66;
      notes = "Only indirect opposition language.";
    } else if (weakSup && weakOpp) {
      position = "mixed";
      confidence = 0.5;
      notes = "Indirect language in both directions.";
    } else if (has("conditional")) {
      position = "mixed";
      confidence = 0.55;
      notes = "Conditional language without a clear direction.";
    } else if (questions.length || has("info")) {
      position = "neutral";
      confidence = 0.72;
      notes = "Asks for information or discussion; no stance stated.";
      return { target, position, confidence, evidence: dedupe(questions.length ? questions : evidence).slice(0, 2), notes };
    }
    if (target.type === "issue" && (position === "support" || position === "oppose")) {
      const cutBetween = (c: Cue, s: Evidence) =>
        s.field !== "subject" && s.start >= c.end && s.start - c.end <= 100 && UNDOING.test(substantive.slice(c.end, s.start));
      const onACut = cues.some((c) => (c.kind === "support" || c.kind === "oppose") && target.spans.some((s) => cutBetween(c, s)));
      if (onACut) {
        position = position === "support" ? "oppose" : "support";
        confidence = Math.min(confidence, 0.8);
        notes = "The stance is on a cut or a repeal, so it is read as the opposite stance on the issue itself.";
      }
    }
    const final = Number(Math.max(0.1, confidence - penalty).toFixed(2));
    return { target, position, confidence: final, evidence: ev, notes: penalty ? `${notes} Attributed from a nearby sentence.` : notes };
  });
}

function dedupe(evs: Evidence[]) {
  const seen = new Set<string>();
  return evs.filter((e) => {
    const k = `${e.start}:${e.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
