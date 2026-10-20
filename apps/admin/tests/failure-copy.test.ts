import { describe, expect, it } from "vitest";
import type { ApiFailure } from "@clinic/api/call";
import { describeFailure } from "@/lib/failure-copy";

const problem = (status: number, code: string): ApiFailure =>
  ({ ok: false, kind: "problem", status, code, detail: "" }) as ApiFailure;

describe("failure copy", () => {
  it("says in plain words what to do when staff actions are throttled (429)", () => {
    for (const code of ["RATE_LIMITED", "INTERNAL_ERROR", "NOT_FOUND"]) {
      const out = describeFailure(problem(429, code), "x");
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/wait a minute/i);
      expect(out.message).toMatch(/try again/i);
    }
  });

  it("tells staff how long to wait when the API sends Retry-After, and names a replayed request", () => {
    const limited = {
      ...problem(429, "RATE_LIMITED"),
      retryAfter: 42,
    } as unknown as ApiFailure;
    expect(describeFailure(limited, "x").message).toBe(
      "Too many changes just now. Try again in 42 s.",
    );
    expect(
      describeFailure(problem(401, "ASSERTION_REPLAYED"), "x").message,
    ).toMatch(/already sent/);
  });

  it("keeps the specific words for the specific codes", () => {
    expect(describeFailure(problem(409, "SLOT_TAKEN"), "x").message).toMatch(
      /taken/,
    );
    expect(
      describeFailure(problem(409, "APPOINTMENT_LOCKED"), "x").message,
    ).toMatch(/locked/);
  });

  it("falls back to a calm line for a service outage and for anything unknown", () => {
    expect(
      describeFailure(problem(503, "DB_UNAVAILABLE"), "x").message,
    ).toMatch(/not answering/);
    expect(
      describeFailure(problem(400, "METHOD_NOT_ALLOWED"), "x").message,
    ).toMatch(/did not work/);
  });
});
