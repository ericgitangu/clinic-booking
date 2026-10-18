import { describe, expect, it } from "vitest";
import { insideChangeWindow } from "@/lib/change-window";

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
