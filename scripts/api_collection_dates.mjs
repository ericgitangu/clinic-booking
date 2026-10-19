// Date helpers for the negative-path requests in the reviewer collection (scripts/api_collection.mjs).
//
// The API checks a booking time in this order (backend/app/domain/booking_rules.py, validate_slot):
// in the past, inside the lead time (BOOKING_TOO_SOON), past the horizon, whole minute, on the grid,
// inside working hours. A request that is meant to reach a LATER check must therefore not be inside
// the lead time, at any hour the run starts. "A day from tomorrow" on the UTC calendar is not enough:
// from 21:00 to 24:00 UTC the clinic (Africa/Nairobi, UTC+3, no daylight saving) is already on the
// next calendar day, so the UTC "tomorrow" is the clinic's today and 03:00 on it can be under an hour
// away. These helpers count days on the clinic calendar and stay two whole days past the clinic's today.
//
// The two day helpers are written to be pasted into a Postman script as text (Function#toString), so
// each is self-contained: no module-level names, no imports. The unit test runs these same functions.

// A clinic-calendar date (YYYY-MM-DD) `n` days after the clinic's today, for the instant `nowMs`.
export function clinicDayAhead(nowMs, n) {
  const clinicOffsetMs = 3 * 3600000; // Africa/Nairobi: UTC+3 all year
  return new Date(nowMs + clinicOffsetMs + n * 86400000).toISOString().slice(0, 10);
}

// 03:00 clinic time, two clinic days from today, with the UTC offset the API used for its slots
// (e.g. "+03:00"). Never a working hour on any day, and never inside the lead time.
export function nightStart(nowMs, offset) {
  return clinicDayAhead(nowMs, 2) + "T03:00:00" + offset;
}

// Seven minutes after a free slot: inside working hours, off the 30-minute grid. The slot came from the
// availability endpoint, so it already clears the lead time and seven minutes later still does.
export function offGridStart(slotStartIso) {
  return new Date(new Date(slotStartIso).getTime() + 7 * 60000).toISOString();
}

// The slot with its offset cut off: a time with no UTC offset, which the API refuses before any slot check.
export function naiveStart(slotStartIso) {
  return slotStartIso.slice(0, 19);
}
