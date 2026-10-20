import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the dashboard keeps its functions alive for the arrival email", () => {
  it("sets a maxDuration that covers the 25 s the doctor email can take after the response", () => {
    const layout = readFileSync("src/app/dashboard/layout.tsx", "utf8");
    const m = /export const maxDuration = (\d+);/.exec(layout);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(30);
  });
});
