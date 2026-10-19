import { describe, expect, it } from "vitest";
import { nextActive } from "@/lib/palette";

describe("palette active option", () => {
  it("never goes below zero when nothing matches", () => {
    expect(nextActive(0, "ArrowDown", 0)).toBe(0);
    expect(nextActive(0, "ArrowUp", 0)).toBe(0);
    expect(nextActive(-1, "ArrowDown", 0)).toBe(0);
  });

  it("stops at the first and the last option instead of wrapping out of range", () => {
    expect(nextActive(0, "ArrowUp", 5)).toBe(0);
    expect(nextActive(4, "ArrowDown", 5)).toBe(4);
    expect(nextActive(2, "ArrowDown", 5)).toBe(3);
    expect(nextActive(2, "ArrowUp", 5)).toBe(1);
  });

  it("repairs an index that is left over from a longer list", () => {
    expect(nextActive(9, "ArrowDown", 3)).toBe(2);
    expect(nextActive(9, "ArrowUp", 3)).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(nextActive(2, "Home", 5)).toBe(0);
    expect(nextActive(2, "End", 5)).toBe(4);
    expect(nextActive(2, "End", 0)).toBe(0);
  });
});
