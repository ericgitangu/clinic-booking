import { describe, expect, it } from "vitest";
import { zProblem } from "@clinic/api/generated/zod.gen";
import { describeProblem } from "@/lib/problems";

// Every code the API can answer with has words of its own: a person never sees the generic
// "something went wrong" for a case the API named, and never sees a code or a status.
const codes = (zProblem.shape.code as unknown as { options: string[] }).options;
const GENERIC = describeProblem("NOT_A_REAL_CODE").message;

describe("problem copy", () => {
  it("reads the codes from the contract", () => {
    expect(codes.length).toBeGreaterThan(20);
    expect(codes).toContain("PATIENT_DOUBLE_BOOKED");
  });

  it.each(codes)("%s has its own plain words", (code) => {
    const { message } = describeProblem(code);
    expect(message).not.toBe(GENERIC);
    expect(message).not.toMatch(/[A-Z]{3,}_[A-Z_]+|\b[45]\d\d\b/);
  });

  it("tells a double booking what happened and what to do", () => {
    expect(describeProblem("PATIENT_DOUBLE_BOOKED").message).toMatch(
      /already have.*(visit|appointment)/i,
    );
    expect(describeProblem("PATIENT_DOUBLE_BOOKED").message).toMatch(
      /another time|different time|My appointments/i,
    );
  });
});

describe("the one-hour rule on changes", () => {
  it("says in plain words that a visit inside the hour cannot be changed", () => {
    const { message } = describeProblem("CHANGE_TOO_LATE");
    expect(message).toMatch(/less than an hour/i);
    expect(message).toMatch(/call the clinic/i);
  });
});
