import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HAPTICS_KEY,
  PATTERNS,
  haptic,
  hapticsEnabled,
  hapticsPlausible,
  setHapticsEnabled,
} from "@clinic/ui/lib/haptics";

interface World {
  coarse?: boolean;
  vibrateFn?: ReturnType<typeof vi.fn>;
  reduced?: boolean;
  active?: boolean | "absent";
  stored?: string | "blocked";
}

function stub({
  vibrateFn,
  reduced = false,
  active = true,
  stored,
  coarse = true,
}: World) {
  const nav: Record<string, unknown> = {};
  if (vibrateFn) nav.vibrate = vibrateFn;
  if (active !== "absent") nav.userActivation = { hasBeenActive: active };
  vi.stubGlobal("navigator", nav);
  const store = new Map<string, string>();
  if (stored && stored !== "blocked") store.set(HAPTICS_KEY, stored);
  const blocked = () => {
    throw new Error("SecurityError");
  };
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches: q.includes("pointer: coarse") ? coarse : reduced,
    }),
    dispatchEvent: () => true,
    localStorage:
      stored === "blocked"
        ? { getItem: blocked, setItem: blocked }
        : {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
          },
  });
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
      expect(haptic(severity)).toBe(true);
      expect(fn).toHaveBeenCalledWith([...PATTERNS[severity]]);
    },
  );
});

describe("haptic does nothing, quietly", () => {
  it("where the Vibration API is missing (iOS Safari, desktop)", () => {
    stub({});
    expect(haptic("success")).toBe(false);
  });

  it("when the person asked for reduced motion", () => {
    const fn = vi.fn(() => true);
    stub({ vibrateFn: fn, reduced: true });
    expect(haptic("critical")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("before the first tap or key press", () => {
    const fn = vi.fn(() => true);
    stub({ vibrateFn: fn, active: false });
    expect(haptic("success")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("when the person switched it off", () => {
    const fn = vi.fn(() => true);
    stub({ vibrateFn: fn, stored: "off" });
    expect(haptic("error")).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("with no browser at all (server render)", () => {
    vi.stubGlobal("navigator", undefined);
    expect(haptic("success")).toBe(false);
  });

  it("and never throws, even if the browser does", () => {
    stub({
      vibrateFn: vi.fn(() => {
        throw new Error("NotAllowedError");
      }),
    });
    expect(() => haptic("success")).not.toThrow();
    expect(haptic("success")).toBe(false);
  });
});

describe("the off switch", () => {
  it("is on by default and remembers a change", () => {
    stub({ vibrateFn: vi.fn(() => true) });
    expect(hapticsEnabled()).toBe(true);
    setHapticsEnabled(false);
    expect(hapticsEnabled()).toBe(false);
    setHapticsEnabled(true);
    expect(hapticsEnabled()).toBe(true);
  });

  it("survives blocked storage: reads as on, writes do not throw", () => {
    stub({ vibrateFn: vi.fn(() => true), stored: "blocked" });
    expect(hapticsEnabled()).toBe(true);
    expect(() => setHapticsEnabled(false)).not.toThrow();
  });
});

describe("when to offer the off switch", () => {
  it("offers it on a touch device that has the Vibration API", () => {
    stub({ vibrateFn: vi.fn(), coarse: true });
    expect(hapticsPlausible()).toBe(true);
  });

  it("does not offer it on a desktop browser that exposes the API but has a mouse", () => {
    stub({ vibrateFn: vi.fn(), coarse: false });
    expect(hapticsPlausible()).toBe(false);
  });

  it("does not offer it where the API is missing, even on touch (iOS Safari)", () => {
    stub({ coarse: true });
    expect(hapticsPlausible()).toBe(false);
  });

  it("does not offer it, and does not throw, with no matchMedia", () => {
    vi.stubGlobal("navigator", { vibrate: vi.fn() });
    vi.stubGlobal("window", {});
    expect(hapticsPlausible()).toBe(false);
  });
});
