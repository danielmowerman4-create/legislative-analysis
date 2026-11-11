import { describe, expect, it } from "vitest";
import { seatLayout, seatOrder, stableHash, voteMark } from "@/lib/chamber";

describe("chamber", () => {
  for (const count of [1, 12, 36, 99, 151, 400]) {
    it(`seats ${count} members without any two touching`, () => {
      const { points, seat, width, height } = seatLayout(count);
      expect(points).toHaveLength(count);
      for (const p of points) {
        expect(p.x - seat).toBeGreaterThanOrEqual(0);
        expect(p.x + seat).toBeLessThanOrEqual(width);
        expect(p.y - seat).toBeGreaterThanOrEqual(0);
        expect(p.y + seat).toBeLessThanOrEqual(height);
      }
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y))
          .toBeGreaterThanOrEqual(seat * 2 - 0.2);
      }
    });
  }

  it("runs left to right, Democrats from the left and Republicans from the right, by district", () => {
    const { points } = seatLayout(151);
    expect(points[0].x).toBeLessThan(points[150].x);
    const seated = seatOrder([
      { name: "C", party: "Republican", district: "2" },
      { name: "A", party: "Democratic", district: "10" },
      { name: "B", party: "Democratic", district: "9" },
      { name: "D", party: null, district: "1" },
    ]);
    expect(seated.map((s) => s.name)).toEqual(["B", "A", "D", "C"]);
  });

  it("counts anything but yes or no as not voting", () => {
    expect(["yes", "no", "absent", "not_voting"].map(voteMark)).toEqual(["yes", "no", "not_voting", "not_voting"]);
  });

  it("gives the same text the same number every time", () => {
    expect(stableHash("HB 5001")).toBe(stableHash("HB 5001"));
    expect(stableHash("HB 5001")).not.toBe(stableHash("HB 5002"));
  });
});
