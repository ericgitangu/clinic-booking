import { describe, expect, it } from "vitest";
import { isOwn, rememberOwn } from "@/lib/own-actions";

describe("own actions", () => {
  it("remembers an appointment the person is changing for a short while, in this tab only", () => {
    rememberOwn("a", 1000);
    expect(isOwn("a", 1000)).toBe(true);
    expect(isOwn("a", 20_999)).toBe(true);
    expect(isOwn("a", 21_001)).toBe(false);
    expect(isOwn("b", 1000)).toBe(false);
  });
});
