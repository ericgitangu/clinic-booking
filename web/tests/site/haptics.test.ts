import { afterEach, describe, expect, it, vi } from "vitest";
import { PATTERNS, vibrate } from "@/lib/haptics";

function stub({
  vibrateFn,
  reduced = false,
}: {
  vibrateFn?: ReturnType<typeof vi.fn>;
  reduced?: boolean;
}) {
  vi.stubGlobal("navigator", vibrateFn ? { vibrate: vibrateFn } : {});
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
}

afterEach(() => vi.unstubAllGlobals());

describe("haptic patterns", () => {
  it("maps each severity to its own short pattern", () => {
    expect(PATTERNS.success).toEqual([12]);
    expect(PATTERNS.info).toEqual([20, 40, 20]);
    expect(PATTERNS.warning).toEqual([20, 40, 20]);
    expect(PATTERNS.error).toEqual([40, 30, 40]);
    expect(PATTERNS.critical).toEqual([80, 40, 80, 40, 80]);
  });

  it.each(Object.keys(PATTERNS) as (keyof typeof PATTERNS)[])(
    "sends the %s pattern to navigator.vibrate",
    (severity) => {
      const fn = vi.fn(() => true);
      stub({ vibrateFn: fn });
      expect(vibrate(severity)).toBe(true);
      expect(fn).toHaveBeenCalledWith([...PATTERNS[severity]]);
    },
  );

  it("does nothing where the Vibration API is missing (iOS Safari)", () => {
    stub({});
    expect(vibrate("success")).toBe(false);
  });

  it("does nothing when the person asked for reduced motion", () => {
    const fn = vi.fn(() => true);
    stub({ vibrateFn: fn, reduced: true });
    expect(vibrate("critical")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
