// Staff emails: the exported API for the admin server actions.
//
//   import { staffBooked, sendStaffEmail } from "@/emails";
//
//   // in a server action, after the staff write has returned and the response is ready:
//   after(async () => {
//     const r = await sendStaffEmail({
//       caller,                                  // the signed-in staff member (same Caller as the write)
//       auditId: change.audit_id,                // Idempotency-Key for Resend, and what /notified marks
//       to: change.patient_email,                // patient_email from the write, or `email` of a notify item
//       deliver: true,                           // the API's `deliver`; true for book/reschedule/cancel/veto
//       mail: staffBooked({ name: change.patient_name, doctor: change.doctor_name,
//                           startsAt: change.starts_at, timezone: change.timezone, reason }),
//     });
//     // r never throws; r.outcome says what happened (see StaffEmailOutcome). Nothing else to do.
//   });
//
// WIRING. Nothing in main calls these yet: the staff write routes and their audit ids arrive with
// backend #63, and the server actions and pages that call them with admin #60 (the redesign). The
// call sites, one per action, each inside `after()` once the write has succeeded:
//
//   action                     write returns             template               to / deliver
//   book on behalf             StaffAppointmentChange    staffBooked            patient_email, true
//   reschedule (staff)         StaffAppointmentChange    staffRescheduled       patient_email, true; previousStartsAt = previous_starts_at
//   cancel (staff)             StaffAppointmentChange    staffCancelled         patient_email, true
//   veto                       StaffAppointmentChange    staffVetoed            patient_email, true
//   remind now                 NotifyResult.items[]      staffRemind            item.email, item.deliver; one call per item
//   doctor running late        NotifyResult.items[]      staffRunningLate       item.email, item.deliver; one call per item
//   invite (admin + viewer)    InviteCreated (no audit)  staffInvite             sendInviteEmail, NOT sendStaffEmail
//
// Today's actions in apps/admin/src/lib/actions.ts (cancelAppointment, rescheduleAppointment) are the
// first two call sites once the client is regenerated; the others are new actions in #60.
// For remind and running late call staffRunningLate only after checking `minutes` (5 to 240): it
// returns { ok: false, error: "INVALID_MINUTES" } otherwise and there is nothing to send.
//
// INVITES have no audit row, so they use sendInviteEmail({ caller, inviteId, to, mail }): the Resend
// idempotency key is `invite/<inviteId>` (the id, never the token, which is a secret and must not
// leave for a third party as a key), the same demo and allowance handling applies, and /notified is
// not called. The link points at /invite/<token> on the admin origin. That page belongs to #60, and
// it must: serve Referrer-Policy: no-referrer and Cache-Control: no-store (next.config.ts already
// sets both for /invite/:path*), never log the URL or the token, and take the token from the path
// on the server only. Residual risk, accepted: the token sits in the path, so Vercel's access log
// for that one request holds it. It is single use, expires in 72 hours and is bound to the invited
// Google address, so a logged token alone grants nothing.
//
// What both senders do, in order: refuse (no reserve, no send, no /notified) when deliver is false,
// the id is missing, there is no recipient, or the recipient is a demo address (isDemoRecipient);
// reserve one email from the day's and month's allowance (/internal/emails/reserve); on a cap hit or
// a failed reserve send nothing and leave notified=false; send through the shared sender
// (@clinic/api/mail); give the reservation back whenever the email did not go (a refusal, a timeout
// or a throw), and log it if giving back fails; on success, for staff emails, POST
// /internal/admin/audit/{id}/notified. Each of reserve, release, notified and the Resend call is cut
// off after 5 s (CALL_TIMEOUT_MS, SEND_TIMEOUT_MS), so the worst case is about 20 s, off the request
// path. Neither function throws. Logs carry ids and outcomes only: no address, name, reason, URL or
// token.
//
// Known limit: a second call with the same id makes Resend return the first result (no second
// email) but takes a second unit of allowance. Callers send each row once.
import "server-only";
import { emailConfigured, type Composed } from "@clinic/api/mail";
import { logError } from "@clinic/api/proxy/log";
import type { Caller } from "@clinic/api/call";
import {
  defaultPorts,
  type Reservation,
  type StaffEmailPorts,
} from "@/emails/ports";

// RFC 2606 / 6761 names that can never reach a person: the three example domains, and the reserved
// top-level names test, example, invalid and localhost. A name matches when it is one of these or
// ends in ".<one of these>", so a.example.com, mail.test and host.localhost are all demo. The API
// marks only the example domains `deliver: false` (backend/app/domain/notify.py); this list is
// wider on purpose and only ever refuses more, so deliver:true on a reserved name still sends nothing.
const DEMO_NAMES = [
  "example.com",
  "example.net",
  "example.org",
  "example",
  "test",
  "invalid",
  "localhost",
] as const;

export function isDemoRecipient(email: string): boolean {
  const domain = (email.trim().toLowerCase().split("@").pop() ?? "").replace(
    /\.+$/,
    "",
  );
  if (domain === "") return false;
  return DEMO_NAMES.some((n) => domain === n || domain.endsWith(`.${n}`));
}

export type StaffEmailOutcome =
  | "sent" // Resend accepted it; `notified` says whether the audit row was marked
  | "not-deliverable" // deliver was false
  | "no-id" // no audit id (or invite id) to key the send on
  | "no-recipient" // no address on file
  | "demo-recipient" // a reserved name: never sent
  | "not-configured" // RESEND_API_KEY is not set in this app
  | "cap-hit" // the day's or month's allowance is used up: nothing sent, notified stays false
  | "reserve-failed" // the allowance could not be reserved: fails closed, nothing sent
  | "send-failed" // Resend refused, timed out or was unreachable; the reservation was given back
  | "error"; // anything unexpected, caught here

export interface StaffEmailResult {
  auditId: string;
  outcome: StaffEmailOutcome;
  sent: boolean;
  /** True only when the API accepted POST /audit/{id}/notified. Always false for invites. */
  notified: boolean;
}

export interface StaffEmailInput {
  caller: Caller;
  auditId: string;
  to: string | null | undefined;
  deliver: boolean;
  mail: Composed;
}

export interface InviteEmailInput {
  caller: Caller;
  /** `id` of the invite (InviteCreated.id). Not the token. */
  inviteId: string;
  to: string | null | undefined;
  mail: Composed;
}

const result = (
  auditId: string,
  outcome: StaffEmailOutcome,
  sent = false,
  notified = false,
): StaffEmailResult => ({ auditId, outcome, sent, notified });

interface Job {
  caller: Caller;
  /** Idempotency-Key for Resend. */
  key: string;
  /** What the log and the result call it: an audit id or an invite id. */
  id: string;
  to: string | null | undefined;
  deliver: boolean;
  mail: Composed;
  /** Marks the audit row after a send; absent for invites. */
  mark?: boolean;
}

async function run(
  job: Job,
  ports: StaffEmailPorts,
): Promise<StaffEmailResult> {
  const { id, caller } = job;
  let taken: Reservation | undefined;
  let spent = false; // the email went out, so the reservation is rightly used
  try {
    if (!job.deliver) return result(id, "not-deliverable");
    if (typeof id !== "string" || id.trim() === "")
      return result(String(id ?? ""), "no-id");
    const to = job.to?.trim();
    if (!to) return result(id, "no-recipient");
    if (isDemoRecipient(to)) return result(id, "demo-recipient");
    if (!emailConfigured()) return result(id, "not-configured");

    // Fails closed: if the allowance cannot be reserved nothing is sent, so a broken counter can
    // never turn into unlimited email.
    const reserved = await ports.reserve(caller);
    if (!reserved.ok) {
      logError("staff email dropped: the allowance could not be reserved", {
        audit: id,
        code: reserved.code,
      });
      return result(id, "reserve-failed");
    }
    if (!reserved.data.granted) {
      logError(
        `staff email dropped: the ${reserved.data.reason}'s limit is used up`,
        { audit: id },
      );
      return result(id, "cap-hit");
    }
    taken = reserved.data;

    const sent = await ports.send(to, job.mail, job.key);
    if (!sent.ok) {
      logError("staff email not sent", {
        audit: id,
        reason: sent.reason,
        status: sent.status,
      });
      return result(id, "send-failed");
    }
    spent = true;

    if (!job.mark) return result(id, "sent", true, false);
    const marked = await ports.markNotified(caller, id);
    if (!marked.ok) {
      // The patient has the email; only the record of it is missing. Not retried here.
      logError("staff email sent but the audit row was not marked notified", {
        audit: id,
        code: marked.code,
      });
      return result(id, "sent", true, false);
    }
    return result(id, "sent", true, true);
  } catch (err) {
    logError("staff email failed", {
      audit: id,
      // The name of the error only: its message could carry an address or a URL.
      detail: err instanceof Error ? err.name : "unknown",
    });
    return result(String(id ?? ""), spent ? "sent" : "error", spent, false);
  } finally {
    // Any exit after a grant that did not send an email gives the unit back.
    if (taken && !spent) {
      try {
        const given = await ports.release(caller, {
          day: taken.day,
          month: taken.month,
        });
        if (!given.ok)
          logError("staff email: the reserved allowance was not given back", {
            audit: id,
            code: given.code,
          });
      } catch (err) {
        logError("staff email: the reserved allowance was not given back", {
          audit: id,
          detail: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
}

/** One email about one audit row (book, reschedule, cancel, veto, remind, running late). */
export const sendStaffEmail = (
  input: StaffEmailInput,
  ports: StaffEmailPorts = defaultPorts,
): Promise<StaffEmailResult> =>
  run(
    {
      caller: input.caller,
      key: input.auditId,
      id: input.auditId,
      to: input.to,
      deliver: input.deliver,
      mail: input.mail,
      mark: true,
    },
    ports,
  );

/** The invitation email. Invites have no audit row, so there is no /notified call. */
export const sendInviteEmail = (
  input: InviteEmailInput,
  ports: StaffEmailPorts = defaultPorts,
): Promise<StaffEmailResult> =>
  run(
    {
      caller: input.caller,
      key: `invite/${input.inviteId}`,
      id: input.inviteId,
      to: input.to,
      deliver: true,
      mail: input.mail,
    },
    ports,
  );
