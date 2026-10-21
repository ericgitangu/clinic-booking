import type { AuditEntry } from "@clinic/api/generated";

// One plain line per action the audit trail can hold. Keyed by the generated action type, so a new
// action in the API does not build until it has a label here.
export const AUDIT_ACTION: Record<AuditEntry["action"], string> = {
  book: "Booked for a patient",
  reschedule: "Moved",
  cancel: "Cancelled",
  veto: "Undid a patient change and locked",
  unlock: "Unlocked",
  arrived: "Marked arrived",
  no_show: "Marked no-show",
  reminder_now: "Sent a reminder",
  running_late: "Told patients the doctor is running late",
  invite_create: "Invited a staff member",
  invite_revoke: "Revoked an invitation",
  invite_accept: "Accepted an invitation",
  doctor_email: "Changed a doctor's arrival email",
  pass_create: "Made a reviewer pass",
  pass_revoke: "Revoked a reviewer pass",
  pass_accept: "Joined with a reviewer pass",
};
