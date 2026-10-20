// A visit the clinic's staff vetoed is locked: only staff can change it, and the API answers a
// patient's cancel or reschedule with APPOINTMENT_LOCKED. The screen says so instead of offering
// buttons that can only fail. The flag is all the patient is told, never the staff reason.
export const STAFF_LOCK_TITLE = "Locked by the clinic";
export const STAFF_LOCK_NOTE =
  "The clinic has locked this visit, so it can no longer be moved or cancelled online. Call the clinic if you need a change.";
