import type { ApiFailure } from "@clinic/api/call";

export type ActionResult =
  { ok: true; message: string } | { ok: false; message: string };

const COPY: Record<string, string> = {
  ACCESS_EXISTS: "That email already has access. Change its role instead.",
  ACCESS_NOT_FOUND: "That email has no active access.",
  OWNER_PROTECTED: "The owner's access is fixed and cannot be changed.",
  APPOINTMENT_ALREADY_CANCELLED: "This appointment is already cancelled.",
  APPOINTMENT_ALREADY_STARTED: "This appointment has already started.",
  CHANGE_TOO_LATE:
    "This visit starts in less than an hour, so a patient cannot change it. Staff can; try again.",
  APPOINTMENT_LOCKED: "This appointment is locked by staff.",
  NOTHING_TO_VETO:
    "The patient has not changed this appointment, so there is nothing to undo.",
  ROLE_ESCALATION: "Only the owner can change an admin's access.",
  INVITE_INVALID: "That invitation is not valid.",
  RATE_LIMITED:
    "You have made a lot of changes in a short time. Wait a minute, then try again.",
  APPOINTMENT_NOT_FOUND: "That appointment could not be found.",
  ATTENDANCE_WINDOW_CLOSED:
    "Arrival can be marked from 15 minutes before the visit until 2 hours after it starts.",
  PATIENT_PHONE_EXISTS: "A patient with that phone number already exists.",
  UNKNOWN_DOCTOR: "That doctor is not available.",
  SLOT_TAKEN: "That time was just taken. Pick another.",
  SLOT_IN_PAST: "That time has passed. Pick a later one.",
  BOOKING_TOO_SOON: "That time is too soon to book. Pick a later one.",
  OUTSIDE_WORKING_HOURS: "The doctor does not work at that time.",
  PATIENT_DOUBLE_BOOKED: "The patient already has an appointment then.",
  FORBIDDEN: "Your account is not allowed to do this.",
};

// `invalid` is what to say when the generated request schema refused the input, before anything
// was sent.
export function describeFailure(f: ApiFailure, invalid: string): ActionResult {
  if (f.kind === "invalid_request") return { ok: false, message: invalid };
  // Too many writes in a short time, from the per-person throttle on staff actions (or the
  // invitation limit): the same plain words whichever code the API names, and the way out.
  if (f.status === 429) return { ok: false, message: COPY.RATE_LIMITED! };
  const known = COPY[f.code];
  if (known) return { ok: false, message: known };
  if (f.status >= 500)
    return {
      ok: false,
      message: "The clinic service is not answering. Try again in a moment.",
    };
  return { ok: false, message: "That did not work. Try again." };
}
