import { describe, expect, it } from "vitest";
import { evaluate } from "./run";

describe("classification evaluation", () => {
  for (const split of ["dev", "test"] as const) {
    it(`${split}: auto-accepted bill links and positions are at least 95% precise`, async () => {
      const r = await evaluate(split);
      expect(r.billAutoPrecision).toBeGreaterThanOrEqual(0.95);
      expect(r.positionAutoPrecision).toBeGreaterThanOrEqual(0.95);
      expect(r.billResolutionAccuracy).toBeGreaterThanOrEqual(0.95);
      expect(r.billExtraction.recall).toBe(1);
    });
  }
});
