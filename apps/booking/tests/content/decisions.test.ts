import { describe, expect, it } from "vitest";
import {
  DECISIONS,
  DECISIONS_DRAFT,
  DECISIONS_INTRO,
  PLACEHOLDER_TEXT,
} from "@/content/decisions";

const FILLED = DECISIONS.filter((d) => !d.placeholder);

describe("decisions content", () => {
  it("has 8 to 10 entries with unique ids", () => {
    expect(DECISIONS.length).toBeGreaterThanOrEqual(8);
    expect(DECISIONS.length).toBeLessThanOrEqual(10);
    expect(new Set(DECISIONS.map((d) => d.id)).size).toBe(DECISIONS.length);
  });

  it("gives every written entry all four parts", () => {
    expect(FILLED.length).toBeGreaterThan(0);
    for (const d of FILLED) {
      for (const part of ["decision", "gaveUp", "why", "revisit"] as const) {
        expect(d[part].trim(), `${d.id}.${part}`).not.toBe("");
      }
    }
  });

  it("has no placeholder left, and any future one keeps the agreed wording", () => {
    const placeholders = DECISIONS.filter((d) => d.placeholder);
    expect(placeholders).toHaveLength(0);
    expect(FILLED).toHaveLength(DECISIONS.length);
    expect(PLACEHOLDER_TEXT).toBe("Decision pending engineer sign-off");
  });

  it("says why Go is there in the entry the landing line links to", () => {
    const go = DECISIONS.find((d) => d.id === "go");
    expect(go?.title).toBe("A small Go service for the staff live feed");
    expect(go?.gaveUp).toContain("900 vCPU-seconds");
    expect(go?.gaveUp).toContain("to be measured after the first deploy");
  });

  it("uses no em or en dashes anywhere in the copy", () => {
    const all = JSON.stringify([DECISIONS, DECISIONS_INTRO]);
    expect(all).not.toMatch(/[–—]/);
  });

  it("keeps the draft flag a plain boolean", () => {
    expect(typeof DECISIONS_DRAFT).toBe("boolean");
  });
});
