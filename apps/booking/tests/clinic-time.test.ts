import { describe, expect, it } from "vitest";
import { addDays, clinicDay, formatTime, isValidDay } from "@/lib/clinic-time";
import { describeProblem } from "@/lib/problems";

describe("clinic time", () => {
  it("names the Nairobi day for an instant, not the UTC day", () => {
    expect(clinicDay("2026-10-17T22:30:00Z")).toBe("2026-10-18");
    expect(clinicDay("2026-10-17T20:59:00Z")).toBe("2026-10-17");
  });
  it("adds days across a month end", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("accepts real calendar days only", () => {
    expect(isValidDay("2026-10-17")).toBe(true);
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("17/10/2026")).toBe(false);
    expect(isValidDay(undefined)).toBe(false);
  });
  it("shows slot times in Nairobi time whatever the offset sent", () => {
    expect(formatTime("2026-10-17T06:00:00Z")).toBe("09:00");
    expect(formatTime("2026-10-17T09:00:00+03:00")).toBe("09:00");
  });
});

describe("problem copy", () => {
  it("never shows a code and gives a plain sentence for the codes people hit", () => {
    for (const code of [
      "SLOT_TAKEN",
      "SLOT_IN_PAST",
      "BOOKING_TOO_SOON",
      "APPOINTMENT_ALREADY_CANCELLED",
    ]) {
      const { message } = describeProblem(code);
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]/);
      expect(message.length).toBeGreaterThan(10);
    }
  });
  it("does not confirm that a phone number is registered", () => {
    expect(describeProblem("PATIENT_PHONE_EXISTS").message).not.toMatch(
      /already|registered|exists/i,
    );
  });
  it("tells someone who is not signed in to sign in", () => {
    expect(describeProblem("UNAUTHENTICATED").message).toMatch(/sign in/i);
  });
  it("treats an unknown code as a server problem", () => {
    expect(describeProblem("SOMETHING_NEW").severity).toBe("critical");
  });
});
