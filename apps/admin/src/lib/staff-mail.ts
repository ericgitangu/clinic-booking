import "server-only";
import type { Caller } from "@clinic/api/call";
import type {
  InviteCreated,
  StaffAppointmentChange,
} from "@clinic/api/generated";
import {
  sendInviteEmail,
  sendStaffEmail,
  staffBooked,
  staffCancelled,
  staffRescheduled,
  staffVetoed,
  type StaffEmailResult,
} from "@/emails";

// The call sites listed at the top of emails/send.ts, one function each, so the actions stay short
// and the wiring can be tested without a server. Each is meant to run inside after(), once the
// staff write has returned: it never throws and the response does not wait on it. A demo recipient
// is refused by the sender (outcome "demo-recipient"): nothing is sent and nothing is marked.

export type PatientNotice = "booked" | "rescheduled" | "cancelled" | "vetoed";

export interface Senders {
  staff: typeof sendStaffEmail;
  invite: typeof sendInviteEmail;
}

const live: Senders = { staff: sendStaffEmail, invite: sendInviteEmail };

type Change = Pick<
  StaffAppointmentChange,
  | "audit_id"
  | "patient_email"
  | "patient_name"
  | "doctor_name"
  | "starts_at"
  | "timezone"
  | "previous_starts_at"
>;

function compose(kind: PatientNotice, c: Change, reason: string) {
  const facts = {
    name: c.patient_name,
    doctor: c.doctor_name,
    startsAt: c.starts_at,
    timezone: c.timezone,
    reason,
  };
  switch (kind) {
    case "booked":
      return staffBooked(facts);
    case "rescheduled":
      return staffRescheduled({
        ...facts,
        previousStartsAt: c.previous_starts_at,
      });
    case "cancelled":
      return staffCancelled(facts);
    case "vetoed":
      return staffVetoed({
        ...facts,
        previousStartsAt: c.previous_starts_at,
      });
  }
}

/** The patient's email about a staff book, move, cancel or veto. */
export async function noticeToPatient(
  kind: PatientNotice,
  caller: Caller,
  change: Change,
  reason: string,
  send: Senders = live,
): Promise<StaffEmailResult> {
  return send.staff({
    caller,
    // No audit row, nothing to key the send on: the sender answers "no-id" and sends nothing.
    auditId: change.audit_id ?? "",
    to: change.patient_email,
    deliver: true,
    mail: compose(kind, change, reason),
  });
}

/** The invitation email, from the create response (which carries the one-time token). */
export async function noticeOfInvite(
  caller: Caller,
  invite: Pick<
    InviteCreated,
    "id" | "audit_id" | "email" | "deliver" | "role" | "expires_at" | "token"
  >,
  send: Senders = live,
): Promise<StaffEmailResult> {
  return send.invite({
    caller,
    inviteId: invite.id,
    auditId: invite.audit_id,
    to: invite.email,
    deliver: invite.deliver,
    role: invite.role,
    expiresAt: invite.expires_at,
    token: invite.token,
  });
}
