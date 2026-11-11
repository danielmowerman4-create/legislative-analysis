export type ParsedAddress = { line1: string; city: string; state: string; postalCode: string };

const SUFFIX = "street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|boulevard|blvd|way|place|pl|parkway|pkwy|highway|hwy|trail|trl|terrace|ter|pike|loop|path|square|sq|crossing|xing|ridge|run|walk";
const STREET_PART = `\\d{1,6}\\s+[A-Za-z0-9.' -]*?\\b(?:${SUFFIX})\\b\\.?(?:\\s+(?:N|S|E|W|NE|NW|SE|SW)\\b\\.?)?(?:,?\\s*(?:apt|apartment|unit|suite|ste|#)\\.?\\s*[\\w-]+)?`;
const PLACE_PART = "([A-Za-z][A-Za-z .'-]*?),?\\s+([A-Za-z]{2})\\.?\\s+(\\d{5})(?:-\\d{4})?";

const ONE_LINE = new RegExp(`(${STREET_PART})[,\\s]+${PLACE_PART}\\b`, "i");
const STREET_LINE = new RegExp(`^\\s*(${STREET_PART})\\s*,?\\s*$`, "i");
const PLACE_LINE = new RegExp(`^\\s*${PLACE_PART}\\s*$`, "i");

// ZZ is the fictional Demo State.
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ZZ".split(" "));

const OWN_ADDRESS = /\b(i\s+live\s+at|we\s+live\s+at|my\s+(?:home\s+|mailing\s+)?address\s+is|our\s+(?:home\s+|mailing\s+)?address\s+is|i\s+reside\s+at|we\s+reside\s+at|my\s+home\s+is\s+at)\b/i;

function build(line1: string, city: string, state: string, postalCode: string): ParsedAddress | null {
  const st = state.toUpperCase();
  if (!STATES.has(st)) return null;
  return { line1: line1.replace(/\s+/g, " ").trim().replace(/[,.]$/, ""), city: city.replace(/\s+/g, " ").trim(), state: st, postalCode };
}

export function parseAddress(text: string): ParsedAddress | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const one = lines[i].match(ONE_LINE);
    if (one) {
      const a = build(one[1], one[2], one[3], one[4]);
      if (a) return a;
    }
    const place = lines[i].match(PLACE_LINE);
    const street = i > 0 ? lines[i - 1].match(STREET_LINE) : null;
    if (place && street) {
      const a = build(street[1], place[1], place[2], place[3]);
      if (a) return a;
    }
  }
  return null;
}

export function findWriterAddress(input: { substantive: string; signature: string | null }): ParsedAddress | null {
  if (input.signature) {
    const a = parseAddress(input.signature);
    if (a) return a;
  }
  const lines = input.substantive.split("\n");
  for (const line of lines) {
    if (OWN_ADDRESS.test(line)) {
      const a = parseAddress(line);
      if (a) return a;
    }
  }
  return parseAddress(lines.filter((l) => l.trim()).slice(-3).filter((l) => /^\s*\d/.test(l) || PLACE_LINE.test(l)).join("\n"));
}

export const formatAddress = (a: ParsedAddress) => `${a.line1}, ${a.city}, ${a.state} ${a.postalCode}`;
export const normalizeAddress = (a: ParsedAddress) => formatAddress(a).toLowerCase().replace(/[^a-z0-9]/g, "");

export const normalizeDistrict = (d: string | number | null | undefined) =>
  d === null || d === undefined
    ? null
    : String(d)
        .toUpperCase()
        .replace(/^(?:HD|SD|DISTRICT)[-\s]*/, "")
        .trim()
        .replace(/^0+(?=\d)/, "") || null;
