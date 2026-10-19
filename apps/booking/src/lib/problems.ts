// What each API problem code says to a person. The code stays in the result so the screen can act
// on it (SLOT_TAKEN offers other times); the words never show a code or a status.
export type Severity = "warning" | "error" | "critical";

const COPY: Record<string, { message: string; severity: Severity }> = {
  SLOT_TAKEN: { message: "That time was just taken.", severity: "warning" },
  PATIENT_DOUBLE_BOOKED: {
    message:
      "You already have an appointment at that time. Pick another time, or look in My appointments.",
    severity: "warning",
  },
  SLOT_IN_PAST: {
    message: "That time has already passed. Pick a later one.",
    severity: "warning",
  },
  BOOKING_TOO_SOON: {
    message: "Appointments need at least an hour's notice. Pick a later time.",
    severity: "warning",
  },
  DATE_OUT_OF_RANGE: {
    message: "That date is too far ahead to book yet.",
    severity: "warning",
  },
  SLOT_MISALIGNED: {
    message: "That is not a bookable time. Pick one from the list.",
    severity: "warning",
  },
  OUTSIDE_WORKING_HOURS: {
    message: "The doctor does not work at that time. Pick one from the list.",
    severity: "warning",
  },
  APPOINTMENT_ALREADY_CANCELLED: {
    message: "This appointment is already cancelled.",
    severity: "warning",
  },
  CHANGE_TOO_LATE: {
    message:
      "This visit starts in less than an hour, so it can no longer be cancelled or moved in the app. Please call the clinic.",
    severity: "warning",
  },
  APPOINTMENT_ALREADY_STARTED: {
    message:
      "This appointment has already started, so it can no longer be changed.",
    severity: "warning",
  },
  PATIENT_PHONE_EXISTS: {
    message:
      "We could not create that patient. Use a different number, or leave it out.",
    severity: "error",
  },
  VALIDATION_ERROR: {
    message: "Some details need another look.",
    severity: "error",
  },
  APPOINTMENT_NOT_FOUND: {
    message: "We could not find that appointment.",
    severity: "error",
  },
  DOCTOR_NOT_FOUND: {
    message: "We could not find that doctor.",
    severity: "error",
  },
  CONCURRENT_UPDATE: {
    message: "Someone changed this at the same moment. Try again.",
    severity: "warning",
  },
  UNAUTHENTICATED: {
    message: "Sign in with Google to continue.",
    severity: "warning",
  },
  PATIENT_NOT_FOUND: {
    message: "We could not find your patient record. Try booking again.",
    severity: "error",
  },
  CONTRACT_VIOLATION: {
    message: "Something went wrong on our side. Try again in a moment.",
    severity: "critical",
  },
  FORBIDDEN: {
    message: "You don't have access to this.",
    severity: "error",
  },
  TIMEZONE_REQUIRED: {
    message: "We could not tell the clinic's time zone. Try again in a moment.",
    severity: "error",
  },
  UNKNOWN_DOCTOR: {
    message: "We could not find that doctor.",
    severity: "error",
  },
  UNKNOWN_PATIENT: {
    message: "We could not find your patient record. Try booking again.",
    severity: "error",
  },
  IDEMPOTENCY_KEY_REUSED: {
    message:
      "That booking attempt was already used for a different visit. Reload the page and try again.",
    severity: "warning",
  },
  IDEMPOTENCY_KEY_CONSUMED: {
    message:
      "That booking attempt already finished. Check My appointments before trying again.",
    severity: "warning",
  },
  ACCESS_EXISTS: {
    message: "That person already has access.",
    severity: "warning",
  },
  OWNER_PROTECTED: {
    message: "The owner's access cannot be changed.",
    severity: "warning",
  },
  ROLE_ESCALATION: {
    message: "Your role does not allow changing that access.",
    severity: "warning",
  },
  APPOINTMENT_LOCKED: {
    message:
      "The clinic has to be contacted to change this appointment. Please call the clinic.",
    severity: "warning",
  },
  ATTENDANCE_WINDOW_CLOSED: {
    message:
      "Arrival can only be recorded from 15 minutes before the visit to 2 hours after it starts.",
    severity: "warning",
  },
  NOTHING_TO_VETO: {
    message: "There is no recent patient change to undo on this appointment.",
    severity: "warning",
  },
  INVITE_INVALID: {
    message: "This invitation is not valid. Ask for a new one.",
    severity: "warning",
  },
  ACCESS_NOT_FOUND: {
    message: "We could not find that access entry.",
    severity: "error",
  },
  PROBLEM_NOT_FOUND: {
    message: "We could not find that error description.",
    severity: "error",
  },
  NOT_FOUND: {
    message: "We could not find that page or record.",
    severity: "error",
  },
  METHOD_NOT_ALLOWED: {
    message: "That action is not allowed here.",
    severity: "error",
  },
  DB_UNAVAILABLE: {
    message:
      "The booking system is busy right now. Wait a moment and try again.",
    severity: "critical",
  },
  INTERNAL_ERROR: {
    message: "Something broke on our side. Try again in a moment.",
    severity: "critical",
  },
  CLIENT_ADDRESS_UNKNOWN: {
    message: "We could not check this request. Reload the page and try again.",
    severity: "warning",
  },
  REALTIME_UNAVAILABLE: {
    message:
      "Live updates are off right now. The page still refreshes by itself.",
    severity: "warning",
  },
  RATE_LIMITED: {
    message: "Too many requests. Wait a minute and try again.",
    severity: "warning",
  },
};

// Words for a field the contract refused, chosen by field (the zod issue code is not shown).
const FIELD_COPY: Record<string, string> = {
  full_name: "Enter your full name.",
  phone: "Use international format, like +254712345678.",
  email: "Enter a valid email address.",
  reason: "Say briefly why (at least 3 characters).",
  starts_at: "Pick a time.",
  doctor_id: "Pick a doctor.",
};

export function fieldMessages(
  issues: { field: string; code: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues)
    out[i.field] ??= FIELD_COPY[i.field] ?? "Check this field.";
  return out;
}

export function describeProblem(code: string): {
  message: string;
  severity: Severity;
} {
  return (
    COPY[code] ?? {
      message: "Something went wrong on our side. Try again in a moment.",
      severity: "critical",
    }
  );
}
