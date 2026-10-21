// Staff emails. The API and the rules are documented at the top of ./send.ts.
export {
  doctorArrived,
  firstNameAndInitial,
  passAccepted,
  staffBooked,
  staffCancelled,
  staffInvite,
  staffRemind,
  staffRescheduled,
  staffRunningLate,
  staffVetoed,
  escapeHtml,
  LATE_MINUTES,
  type RunningLateMail,
  type AppointmentFacts,
  type Composed,
} from "@/emails/templates";
export {
  isDemoRecipient,
  sendInviteEmail,
  sendPassNotice,
  sendStaffEmail,
  type InviteEmailInput,
  type PassNoticeInput,
  type StaffEmailInput,
  type StaffEmailOutcome,
  type StaffEmailResult,
} from "@/emails/send";
export { CALL_TIMEOUT_MS, STAFF_FROM } from "@/emails/ports";
