import { createHash } from "node:crypto";
import { sentences } from "./preprocess";

const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

const GREETING = /^(dear|hello|hi|to|honorable|representative|senator)\b/i;

function bodyWords(substantive: string) {
  const lines = substantive.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length && GREETING.test(lines[0])) lines.shift();
  return wordsOf(lines.join(" "));
}

const MIN_TEMPLATE_WORDS = 25;

// 64-bit SimHash over word 3-shingles of the body, greeting stripped.
export function templateFingerprint(substantive: string, minWords = MIN_TEMPLATE_WORDS): string | null {
  const words = bodyWords(substantive);
  if (words.length < minWords) return null;
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const h = createHash("md5").update(`${words[i]} ${words[i + 1]} ${words[i + 2]}`).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = h[bit >> 3];
      v[bit] += (byte >> (bit & 7)) & 1 ? 1 : -1;
    }
  }
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble++) {
    let n = 0;
    for (let b = 0; b < 4; b++) if (v[nibble * 4 + b] > 0) n |= 1 << b;
    hex += n.toString(16);
  }
  return hex;
}

function hash32(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function trigrams(words: string[]) {
  const out: number[] = [];
  for (let i = 0; i + 2 < words.length; i++) out.push(hash32(`${words[i]} ${words[i + 1]} ${words[i + 2]}`));
  return out;
}

export const shingles = (substantive: string) => [...new Set(trigrams(bodyWords(substantive)))].sort((a, b) => a - b);

const SKETCH_SIZE = 32;
export const sketchOf = (sortedShingles: number[]) => sortedShingles.slice(0, SKETCH_SIZE);

const MIN_CANONICAL = 20;
export const minShinglesFor = (minWords: number) => Math.max(3, Math.min(MIN_CANONICAL, minWords - 5));

export function overlap(a: number[], b: number[], minShingles = MIN_CANONICAL) {
  if (a.length < minShingles || b.length < minShingles) return 0;
  const set = new Set(b);
  let shared = 0;
  for (const x of a) if (set.has(x)) shared++;
  return shared / Math.min(a.length, b.length);
}

export function narrowCanonical(canonical: number[], member: number[], minShingles = MIN_CANONICAL) {
  const set = new Set(member);
  const shared = canonical.filter((x) => set.has(x));
  return shared.length >= minShingles && shared.length >= canonical.length * 0.5 ? shared : canonical;
}

const MIN_NOTE_WORDS = 8;

export function personalNote(substantive: string, canonical: number[]): string | null {
  if (!canonical.length) return null;
  const set = new Set(canonical);
  const kept: string[] = [];
  for (const s of sentences(substantive)) {
    const words = wordsOf(s.text);
    if (words.length < 3 || (GREETING.test(s.text) && words.length <= 6)) continue;
    const grams = trigrams(words);
    const inside = grams.filter((g) => set.has(g)).length;
    if (inside / grams.length < 0.5) kept.push(s.text);
  }
  const note = kept.join(" ");
  return wordsOf(note).length >= MIN_NOTE_WORDS ? note : null;
}
