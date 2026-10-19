import { describe, expect, it } from "vitest";
import { clockOffset, insideChangeWindow } from "@/lib/change-window";

const NOW = Date.parse("2026-10-26T05:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

// The same boundary as the API: less than 60 minutes away is inside the window, exactly 60 is not.
describe("insideChangeWindow", () => {
  it.each([
    [59, true],
    [60, false],
    [61, false],
    [0, true],
    [-5, true],
  ])("a visit %i minutes away: inside = %s", (minutes, inside) => {
    expect(insideChangeWindow(at(minutes), NOW)).toBe(inside);
  });
});

// The screen reads time from the server's clock plus the time that passes in the browser, never
// from the device clock alone.
describe("clockOffset", () => {
  const visit = at(90);
  it("a device clock hours ahead does not close the window", () => {
    const deviceAhead = NOW + 5 * 3_600_000;
    const offset = clockOffset(new Date(NOW).toISOString(), deviceAhead);
    expect(insideChangeWindow(visit, deviceAhead)).toBe(true); // the wrong reading
    expect(insideChangeWindow(visit, deviceAhead + offset)).toBe(false); // the corrected one
  });
  it("a device clock hours behind does not open it", () => {
    const deviceBehind = NOW - 5 * 3_600_000;
    const offset = clockOffset(new Date(NOW).toISOString(), deviceBehind);
    expect(insideChangeWindow(at(30), deviceBehind)).toBe(false); // the wrong reading
    expect(insideChangeWindow(at(30), deviceBehind + offset)).toBe(true);
  });
  it("moves on with the browser: 31 minutes later the 90-minute visit is inside", () => {
    const offset = clockOffset(new Date(NOW).toISOString(), NOW - 7_000);
    expect(insideChangeWindow(visit, NOW - 7_000 + offset + 30 * 60_000)).toBe(
      false,
    );
    expect(insideChangeWindow(visit, NOW - 7_000 + offset + 31 * 60_000)).toBe(
      true,
    );
  });
});
