// What each API problem code says to a person. The code stays in the result so the screen can act
// on it (SLOT_TAKEN offers other times); the words never show a code or a status.
export type Severity = "warning" | "error" | "critical";

const COPY: Record<string, { message: string; severity: Severity }> = {
  SLOT_TAKEN: { message: "That time was just taken.", severity: "warning" },
  PATIENT_DOUBLE_BOOKED: {
    message: "You already have an appointment at that time.",
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
  RATE_LIMITED: {
    message: "Too many requests. Wait a minute and try again.",
    severity: "warning",
  },
};

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
