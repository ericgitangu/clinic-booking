// The one-hour rule for changes: an appointment that starts in less than an hour can no longer be
// cancelled or moved (the API answers 409 CHANGE_TOO_LATE). The screen disables the actions in that
// window so nobody is invited to try; the API stays the authority.
//
// DEBT: this file exists twice, in apps/booking/src/lib and apps/admin/src/lib, with different
// wording for the note only. It belongs in a shared package (packages/ui or packages/api).
// A contract test (backend/tests/contract/test_change_window_constant.py) fails if either copy's
// lead time differs from the API's BOOKING_MIN_LEAD_MINUTES, which is what makes the copy safe.
export const CHANGE_LEAD_MINUTES = 60;

export function insideChangeWindow(startsAt: string, nowMs: number): boolean {
  return Date.parse(startsAt) - nowMs < CHANGE_LEAD_MINUTES * 60_000;
}

// The screen does not trust the device clock. The server sends its own time with the page; the
// difference to this browser's clock, taken once, is added to every later reading, so a clock that
// is wrong by hours neither opens nor closes the window. Time then moves on with the browser.
export function clockOffset(serverNowIso: string, clientNowMs: number): number {
  return Date.parse(serverNowIso) - clientNowMs;
}

// The words when the window opens while the person already has the page (or a dialog) open.
export const CHANGE_WINDOW_JUST_OPENED =
  "This visit now starts in less than an hour, so it can no longer be cancelled or moved.";

export const CHANGE_WINDOW_NOTE =
  "This visit starts in less than an hour, so it can no longer be cancelled or moved in the app. Please call the clinic.";
