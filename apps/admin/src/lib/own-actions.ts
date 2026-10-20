// Remembers, in this tab only, which appointments the person is changing right now, so the live
// toast for their own change is not raised a second time next to the confirmation they already
// get. Another tab of the same person has no entry and does toast: that is the point of it.
const TTL_MS = 20_000;
const mine = new Map<string, number>();

export function rememberOwn(appointmentId: string, now = Date.now()): void {
  mine.set(appointmentId, now + TTL_MS);
}

export function isOwn(appointmentId: string, now = Date.now()): boolean {
  const until = mine.get(appointmentId);
  if (until === undefined) return false;
  if (until < now) {
    mine.delete(appointmentId);
    return false;
  }
  return true;
}

/** The change did not go through: other people's events about it must not be held back. */
export function forgetOwn(appointmentId: string): void {
  mine.delete(appointmentId);
}
