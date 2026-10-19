import { describe, expect, it } from "vitest";
import { inAttendanceWindow, isStillToCome } from "@/lib/attendance-window";

// 10:00 in Nairobi is 07:00Z. The same instant written both ways must give the same answer.
const START_OFFSET = "2026-10-19T10:00:00+03:00";
const START_Z = "2026-10-19T07:00:00Z";
const at = (iso: string, minutes: number) => Date.parse(iso) + minutes * 60_000;

describe("attendance window", () => {
  it("reads a +03:00 start and a Z start as the same instant", () => {
    for (const minutes of [-20, -15, 0, 60, 120, 121]) {
      expect(inAttendanceWindow(START_OFFSET, at(START_Z, minutes))).toBe(
        inAttendanceWindow(START_Z, at(START_Z, minutes)),
      );
    }
  });

  it("opens 15 minutes before the start and closes 2 hours after, edges included", () => {
    expect(inAttendanceWindow(START_Z, at(START_Z, -16))).toBe(false);
    expect(inAttendanceWindow(START_Z, at(START_Z, -15))).toBe(true);
    expect(inAttendanceWindow(START_Z, at(START_Z, 0))).toBe(true);
    expect(inAttendanceWindow(START_Z, at(START_Z, 120))).toBe(true);
    expect(inAttendanceWindow(START_Z, at(START_Z, 121))).toBe(false);
  });

  it("does not offer a mark 3 hours after the start (the string-compare bug)", () => {
    // As strings "…T10:00:00+03:00" sorts after "…T08:00:00Z" although it is 07:00Z.
    expect(inAttendanceWindow(START_OFFSET, at(START_Z, 180))).toBe(false);
  });

  it("an unparseable start offers nothing", () => {
    expect(inAttendanceWindow("not a time", Date.now())).toBe(false);
    expect(isStillToCome("not a time", Date.now())).toBe(false);
  });

  it("a visit is still to come until its start, in either notation", () => {
    expect(isStillToCome(START_OFFSET, at(START_Z, -1))).toBe(true);
    expect(isStillToCome(START_OFFSET, at(START_Z, 0))).toBe(false);
    expect(isStillToCome(START_OFFSET, at(START_Z, 1))).toBe(false);
    expect(isStillToCome(START_Z, at(START_Z, -179))).toBe(true);
  });
});
