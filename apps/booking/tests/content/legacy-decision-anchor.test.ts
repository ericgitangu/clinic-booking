import { describe, expect, it } from "vitest";
import { DECISION_CARDS } from "@/content/architecture";
import { currentDecisionAnchor } from "@/lib/legacy-decision-anchor";

describe("old decision anchors", () => {
  it("maps every old padded id to a card that exists", () => {
    const ids = new Set(DECISION_CARDS.map((c) => c.id));
    for (let n = 1; n <= 35; n++) {
      const old = `adr-${String(n).padStart(4, "0")}`;
      expect(ids.has(currentDecisionAnchor(old)!)).toBe(true);
    }
  });

  it("leaves everything else alone", () => {
    for (const h of [
      "adr-0000",
      "adr-0036",
      "adr-33",
      "decision-3",
      "time",
      "",
    ])
      expect(currentDecisionAnchor(h)).toBeNull();
  });
});
