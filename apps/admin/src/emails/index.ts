// Staff emails. The API and the rules are documented at the top of ./send.ts.
export {
  staffBooked,
  staffCancelled,
  staffInvite,
  staffRemind,
  staffRescheduled,
  staffRunningLate,
  staffVetoed,
  escapeHtml,
  type AppointmentFacts,
  type Composed,
} from "@/emails/templates";
export {
  isDemoRecipient,
  sendStaffEmail,
  type StaffEmailInput,
  type StaffEmailOutcome,
  type StaffEmailResult,
} from "@/emails/send";
export { STAFF_FROM } from "@/emails/ports";
