// Desk marks (arrived, no-show) are allowed from 15 minutes before a visit starts to 2 hours after
// it (the API enforces this and answers 409 ATTENDANCE_WINDOW_CLOSED). The board shows the buttons
// only inside it so nobody is invited to try.
//
// Both sides are parsed to instants before comparing. The API sends starts_at with a numeric offset
// ("+03:00") in some places and as "Z" in others; comparing those as strings orders them wrongly
// by up to the offset (three hours in Nairobi).
export const MARK_BEFORE_MS = 15 * 60_000;
export const MARK_AFTER_MS = 2 * 3_600_000;

export function inAttendanceWindow(startsAt: string, nowMs: number): boolean {
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return false;
  return nowMs >= t - MARK_BEFORE_MS && nowMs <= t + MARK_AFTER_MS;
}

/** True while the visit has not started. Instants, not strings, for the same reason. */
export function isStillToCome(startsAt: string, nowMs: number): boolean {
  const t = Date.parse(startsAt);
  return !Number.isNaN(t) && t > nowMs;
}
