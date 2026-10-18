// The one-hour rule for changes: an appointment that starts in less than an hour can no longer be
// cancelled or moved (the API answers 409 CHANGE_TOO_LATE). The screen hides the actions in that
// window so nobody is invited to try; the API stays the authority.
export const CHANGE_LEAD_MINUTES = 60;

export function insideChangeWindow(startsAt: string, nowMs: number): boolean {
  return Date.parse(startsAt) - nowMs < CHANGE_LEAD_MINUTES * 60_000;
}

export const CHANGE_WINDOW_NOTE =
  "This visit starts in less than an hour, so it can no longer be cancelled or moved. Please contact the clinic.";
