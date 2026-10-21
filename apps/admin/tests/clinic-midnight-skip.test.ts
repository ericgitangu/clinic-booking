import { describe, expect, it } from "vitest";

import { pastHalfHourCanFallOnYesterday } from "../e2e/support/clock";

// Nairobi is UTC+3 all year, so these UTC instants are fixed clinic-local times.
const at = (utc: string) => new Date(utc);

describe("when a past half hour can fall on yesterday's clinic date", () => {
  it("skips at 00:45 local, when two half hours back is 23:30 yesterday", () => {
    expect(pastHalfHourCanFallOnYesterday(2, at("2026-10-20T21:45:00Z"))).toBe(
      true,
    );
  });

  it("skips at 00:30 local, when the deepest slot is 23:30 yesterday", () => {
    // The old hour-0 rule let this one through.
    expect(pastHalfHourCanFallOnYesterday(2, at("2026-10-20T21:30:00Z"))).toBe(
      true,
    );
  });

  it("runs from 01:00 local, when the deepest slot is midnight today", () => {
    expect(pastHalfHourCanFallOnYesterday(2, at("2026-10-20T22:00:00Z"))).toBe(
      false,
    );
  });

  it("uses the deepest slot the move may take, not the one asked for", () => {
    // Asked for none back, but the move may still take up to two back.
    expect(pastHalfHourCanFallOnYesterday(0, at("2026-10-20T21:50:00Z"))).toBe(
      true,
    );
    expect(pastHalfHourCanFallOnYesterday(0, at("2026-10-20T22:05:00Z"))).toBe(
      false,
    );
  });

  it("widens to eight half hours when more than two are asked for", () => {
    expect(pastHalfHourCanFallOnYesterday(6, at("2026-10-21T00:30:00Z"))).toBe(
      true,
    );
    expect(pastHalfHourCanFallOnYesterday(6, at("2026-10-21T01:00:00Z"))).toBe(
      false,
    );
    expect(pastHalfHourCanFallOnYesterday(3, at("2026-10-20T22:30:00Z"))).toBe(
      true,
    );
  });

  it("runs in the middle of the clinic day", () => {
    expect(pastHalfHourCanFallOnYesterday(2, at("2026-10-21T07:00:00Z"))).toBe(
      false,
    );
  });
});
