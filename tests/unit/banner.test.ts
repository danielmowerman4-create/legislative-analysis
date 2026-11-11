import { describe, expect, it } from "vitest";
import { preprocess, stripExternalBanner } from "@/server/classification/preprocess";
import { withoutExternalTag } from "@/server/email/normalize";
import { overlap, shingles } from "@/server/classification/templates";

const LETTER = "Dear Representative,\n\nThe potholes on Elm Street have damaged two of my tires this month. Please ask the county to repair the road before winter.\n\nAnn Lee";
const EXCHANGE = "CAUTION: This email originated from outside of the organization. Do not click links or open attachments unless you recognize the sender and know the content is safe.";

describe("the warning a mail system puts on top of outside mail", () => {
  it("is taken off, however the mail system words or wraps it", () => {
    expect(stripExternalBanner(`${EXCHANGE}\n\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`CAUTION: This email originated from outside of the organization. Do not click links or\nopen attachments unless you recognize the sender and know the content is safe.\n\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`[EXTERNAL]\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`*** EXTERNAL EMAIL ***\n\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`EXTERNAL EMAIL: Do not click any links or open any attachments unless you trust the sender and know the content is safe.\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`This message was sent from outside the House network. Please use caution.\n\n${LETTER}`)).toBe(LETTER);
    expect(stripExternalBanner(`WARNING: This message is from an external sender. Exercise caution when opening attachments. Report suspicious email to the help desk.\n\n${LETTER}`)).toBe(LETTER);
  });

  it("leaves a letter alone when nothing was added, even one that talks about links or caution", () => {
    expect(stripExternalBanner(LETTER)).toBe(LETTER);
    const wary = "I do not click links in emails anymore, so I am writing to you directly about the scam calls my mother keeps getting.";
    expect(stripExternalBanner(wary)).toBe(wary);
    const later = `${LETTER}\n\nPS: this email originated from outside of the organization I work for, on my own time.`;
    expect(stripExternalBanner(later)).toBe(later);
  });

  it("keeps two different letters from looking like one form letter", () => {
    const other = "Hello,\n\nPlease keep bus route 9 running on weekends. I use it to get to work and have no other way to get there.\n\nBen Ray";
    const a = preprocess({ bodyText: `${EXCHANGE}\n\n${LETTER}` });
    const b = preprocess({ bodyText: `${EXCHANGE}\n\n${other}` });
    expect(a.substantive.startsWith("Dear Representative")).toBe(true);
    expect(a.substantive).not.toMatch(/CAUTION|originated/);
    expect(overlap(shingles(a.substantive), shingles(b.substantive), 1)).toBeLessThan(0.2);
    expect(overlap(shingles(`${EXCHANGE}\n\n${LETTER}`), shingles(`${EXCHANGE}\n\n${other}`), 1)).toBeGreaterThan(0.3);
  });

  it("takes the mail system's label off the subject and nothing else", () => {
    expect(withoutExternalTag("[EXTERNAL] Potholes on Elm Street")).toBe("Potholes on Elm Street");
    expect(withoutExternalTag("RE: [EXT] Potholes")).toBe("RE: Potholes");
    expect(withoutExternalTag("(External) Bus route 9")).toBe("Bus route 9");
    expect(withoutExternalTag("EXTERNAL: Bus route 9")).toBe("Bus route 9");
    expect(withoutExternalTag("External review of HB 12")).toBe("External review of HB 12");
    expect(withoutExternalTag("Potholes [photos attached]")).toBe("Potholes [photos attached]");
  });
});
