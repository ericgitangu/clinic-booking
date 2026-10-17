import { describe, expect, it } from "vitest";
import { IDLE_MS, POLL_MS, pickWasTaken, pollInterval } from "@/lib/polling";

describe("patient polling", () => {
  it("polls every 15 s and goes idle after 10 minutes", () => {
    expect(POLL_MS).toBe(15_000);
    expect(IDLE_MS).toBe(600_000);
  });

  it("refetches on the interval until the person goes idle, then stops", () => {
    expect(pollInterval(false)).toBe(POLL_MS);
    expect(pollInterval(true)).toBe(false);
  });

  it("calls a pick taken only when it was set and has left the list", () => {
    const slots = [{ starts_at: "a" }, { starts_at: "b" }];
    expect(pickWasTaken("", slots)).toBe(false);
    expect(pickWasTaken("a", slots)).toBe(false);
    expect(pickWasTaken("c", slots)).toBe(true);
    expect(pickWasTaken("a", [])).toBe(true);
  });
});
