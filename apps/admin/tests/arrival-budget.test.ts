import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ARRIVAL_STEPS, MARGIN_MS, worstCaseMs } from "@/lib/arrival-budget";

const maxDuration = () => {
  const m = /export const maxDuration = (\d+);/.exec(
    readFileSync("src/app/dashboard/layout.tsx", "utf8"),
  );
  if (!m) throw new Error("the dashboard layout sets no maxDuration");
  return Number(m[1]) * 1000;
};

describe("the time marking an arrival can take", () => {
  it("adds up, from the configured timeouts, to at most maxDuration minus the margin", () => {
    const total = worstCaseMs();
    expect(
      total,
      `${ARRIVAL_STEPS.map((s) => `${s.name} ${s.ms / 1000}s`).join(", ")} = ${total / 1000}s`,
    ).toBeLessThanOrEqual(maxDuration() - MARGIN_MS);
  });

  it("is the real worst case: 85 s with today's timeouts (two token exchanges counted), so 120 s leaves 35 s", () => {
    expect(worstCaseMs()).toBe(85_000);
    expect(maxDuration()).toBe(120_000);
    expect(MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("stays inside what a Hobby function may be given with fluid compute (300 s)", () => {
    expect(maxDuration()).toBeLessThanOrEqual(300_000);
  });
});
