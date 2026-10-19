import { describe, expect, it } from "vitest";
import { countDelta, shareDelta } from "@/lib/kpi-delta";
import { properName } from "@/lib/patient-name";

describe("countDelta", () => {
  it("says up, down and no change in words, with the old number", () => {
    expect(countDelta(12, 9, "up")).toEqual({
      direction: "up",
      tone: "good",
      text: "Up 3 from 9",
    });
    expect(countDelta(2, 5, "down")).toMatchObject({
      text: "Down 3 from 5",
      tone: "good",
    });
    expect(countDelta(4, 4, "up")).toMatchObject({
      direction: "same",
      tone: "neutral",
      text: "No change from 4",
    });
  });

  it("marks more cancellations as bad news and keeps neutral measures neutral", () => {
    expect(countDelta(6, 2, "down").tone).toBe("bad");
    expect(countDelta(6, 2, "none").tone).toBe("neutral");
  });

  it("copes with an empty previous period", () => {
    expect(countDelta(3, 0, "up").text).toBe("Up 3 from 0");
  });
});

describe("shareDelta", () => {
  it("moves in percentage points", () => {
    expect(shareDelta(0.45, 0.31, "up")).toMatchObject({
      direction: "up",
      text: "Up 14 points from 31%",
    });
    expect(shareDelta(0.5, 0.49, "up")?.text).toBe("Up 1 point from 49%");
  });

  it("has nothing to compare without working hours", () => {
    expect(shareDelta(null, 0.4, "up")).toBeNull();
    expect(shareDelta(0.4, null, "up")?.text).toBe("No hours before");
    expect(shareDelta(0.4, null, "down", "No bookings before")?.text).toBe(
      "No bookings before",
    );
  });
});

describe("properName", () => {
  it("tidies spacing and shouting, leaves mixed case alone", () => {
    expect(properName("  ACHIENG   OTIENO ")).toBe("Achieng Otieno");
    expect(properName("mary o'neil")).toBe("Mary O'Neil");
    expect(properName("Ruth McDonald")).toBe("Ruth McDonald");
  });
  it("never renders an empty name", () => {
    expect(properName("   ")).toBe("Name not given");
    expect(properName(undefined)).toBe("Name not given");
  });
});
