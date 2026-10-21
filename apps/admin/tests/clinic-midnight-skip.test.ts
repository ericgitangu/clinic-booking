import { describe, expect, it } from "vitest";

import { pastHalfHourCanFallOnYesterday } from "../e2e/support/clock";

// Nairobi is UTC+3 all year, so these UTC instants are fixed clinic-local times.
const at = (utc: string) => new Date(utc);

describe("when a past half hour can fall on yesterday's clinic date", () => {
  it("skips at 01:15 local, when three half hours back is 23:45 yesterday", () => {
    // The admin-e2e failure on 2026-10-20: the visit moved three back left today's board.
    expect(pastHalfHourCanFallOnYesterday(3, at("2026-10-20T22:15:00Z"))).toBe(
      true,
    );
  });

  it("runs from 01:30 local, when the deepest slot is midnight today", () => {
    expect(pastHalfHourCanFallOnYesterday(3, at("2026-10-20T22:30:00Z"))).toBe(
      false,
    );
  });

  it("uses the deepest slot the move may take, not the one asked for", () => {
    // Asked for none back, but the move may still take up to three back.
    expect(pastHalfHourCanFallOnYesterday(0, at("2026-10-20T22:20:00Z"))).toBe(
      true,
    );
  });

  it("widens to eight half hours when more than three are asked for", () => {
    expect(pastHalfHourCanFallOnYesterday(6, at("2026-10-21T00:30:00Z"))).toBe(
      true,
    );
    expect(pastHalfHourCanFallOnYesterday(6, at("2026-10-21T01:00:00Z"))).toBe(
      false,
    );
  });

  it("runs in the middle of the clinic day", () => {
    expect(pastHalfHourCanFallOnYesterday(3, at("2026-10-21T07:00:00Z"))).toBe(
      false,
    );
  });
});
