import { describe, expect, it } from "vitest";
import { durationDelta, formatLead, median } from "@/lib/kpi-delta";

describe("lead time", () => {
  it("takes the middle value, or the mean of the two in the middle", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });

  it("reads in hours, then in days", () => {
    expect(formatLead(5.4)).toBe("5 h");
    expect(formatLead(60)).toBe("2.5 days");
  });

  it("says how it moved, and ignores a wobble under half an hour", () => {
    expect(durationDelta(60, 24)?.text).toBe("Up 36 h from 24 h");
    expect(durationDelta(24.2, 24)?.direction).toBe("same");
    expect(durationDelta(null, 24)).toBeNull();
  });
});
