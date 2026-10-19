import { describe, expect, it } from "vitest";
import {
  addDays,
  eachDay,
  formatBucket,
  formatSlot,
  lastDays,
  localDate,
} from "@/lib/clinic-time";

describe("clinic time", () => {
  it("uses the Nairobi date, not the UTC one", () => {
    expect(localDate(new Date("2026-10-16T21:30:00Z"))).toBe("2026-10-17");
  });

  it("builds an inclusive-exclusive range ending today", () => {
    expect(lastDays(new Date("2026-10-17T10:00:00Z"), 7)).toEqual({
      from: "2026-10-11",
      to: "2026-10-18",
    });
  });

  it("walks day by day across a month end", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(eachDay("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  it("formats a slot in clinic time", () => {
    expect(formatSlot("2026-10-20T06:00:00Z")).toBe("Tue 20 Oct 09:00");
  });

  it("formats a bucket label", () => {
    expect(formatBucket("2026-10-20T00:00:00")).toBe("20 Oct");
  });
});

describe("humanDate", () => {
  it("writes a clinic date the way a person says it", async () => {
    const { humanDate } = await import("@/lib/clinic-time");
    expect(humanDate("2026-10-20")).toBe("Tuesday 20 October 2026");
    expect(humanDate("2026-12-31")).toBe("Thursday 31 December 2026");
  });
});
