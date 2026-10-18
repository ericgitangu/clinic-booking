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
//       deliver: true,                           // the API's `deliver`; always true for book/reschedule/cancel/veto
//       mail: staffBooked({ name: change.patient_name, doctor: change.doctor_name,
//                           startsAt: change.starts_at, timezone: change.timezone, reason }),
//     });
//     // r never throws; r.outcome says what happened (see StaffEmailOutcome). Nothing else to do.
//   });
//
// Templates (each returns { subject, html, text }; times in East Africa Time; the reason is HTML-escaped):
//   staffBooked, staffRescheduled, staffCancelled, staffVetoed   patient mail, reason shown
//   staffRemind, staffRunningLate                                 patient mail, from /remind and /running-late items
//   staffInvite                                                   token in the URL path only: SITE.url/invite/<token>
//
// For /remind and /running-late: loop over `items` and call sendStaffEmail once per item with that
// item's audit_id, email and deliver. Items with deliver:false are skipped here (demo recipients and
// patients with no email are never sent to, whatever `deliver` says; Resend is not called).
//
// What it does, in order: refuses (no send, no reserve, no /notified) when deliver is false, there is
// no recipient, or the recipient is a reserved demo domain; reserves one email from the day's and
// month's allowance (/internal/emails/reserve) and, when a cap is hit, sends nothing and leaves
// notified=false (it does NOT call /notified); sends through the shared sender (@clinic/api/mail,
// 5 s abort, Idempotency-Key = auditId); releases the reservation if the send fails; on success calls
// POST /internal/admin/audit/{id}/notified. It never throws and logs only ids and outcomes: no
// address, name, reason or invite token ever reaches a log line.
//
// Known limit: a second call with the same auditId makes Resend return the first result (no second
// email) but takes a second unit of allowance. Callers send each audit row once.
import { emailConfigured, type Composed } from "@clinic/api/mail";
import { logError } from "@clinic/api/proxy/log";
import type { Caller } from "@clinic/api/call";
import {
  defaultPorts,
  type Reservation,
  type StaffEmailPorts,
} from "@/emails/ports";

// The reserved example domains (RFC 2606). The API marks these deliver:false already; this is the
// same list as backend/app/domain/notify.py so the sender refuses them even if a caller passes
// deliver:true by mistake.
const DEMO_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

export const isDemoRecipient = (email: string): boolean =>
  DEMO_DOMAINS.has(email.trim().toLowerCase().split("@").pop() ?? "");

export type StaffEmailOutcome =
  | "sent" // Resend accepted it; `notified` says whether the audit row was marked
  | "not-deliverable" // deliver was false
  | "no-recipient" // no address on file
  | "demo-recipient" // a reserved example domain: never sent
  | "not-configured" // RESEND_API_KEY is not set in this app
  | "cap-hit" // the day's or month's allowance is used up: nothing sent, notified stays false
  | "reserve-failed" // the allowance could not be reserved: fails closed, nothing sent
  | "send-failed" // Resend refused, timed out or was unreachable; the reservation was given back
  | "error"; // anything unexpected, caught here

export interface StaffEmailResult {
  auditId: string;
  outcome: StaffEmailOutcome;
  sent: boolean;
  /** True only when the API accepted POST /audit/{id}/notified. */
  notified: boolean;
}

export interface StaffEmailInput {
  caller: Caller;
  auditId: string;
  to: string | null | undefined;
  deliver: boolean;
  mail: Composed;
}

const result = (
  auditId: string,
  outcome: StaffEmailOutcome,
  sent = false,
  notified = false,
): StaffEmailResult => ({ auditId, outcome, sent, notified });

export async function sendStaffEmail(
  input: StaffEmailInput,
  ports: StaffEmailPorts = defaultPorts,
): Promise<StaffEmailResult> {
  const { auditId, caller } = input;
  try {
    if (!input.deliver) return result(auditId, "not-deliverable");
    const to = input.to?.trim();
    if (!to) return result(auditId, "no-recipient");
    if (isDemoRecipient(to)) return result(auditId, "demo-recipient");
    if (!emailConfigured()) return result(auditId, "not-configured");

    // Fails closed: if the allowance cannot be reserved nothing is sent, so a broken counter can
    // never turn into unlimited email.
    const reserved = await ports.reserve(caller);
    if (!reserved.ok) {
      logError("staff email dropped: the allowance could not be reserved", {
        audit: auditId,
        code: reserved.code,
      });
      return result(auditId, "reserve-failed");
    }
    const taken: Reservation = reserved.data;
    if (!taken.granted) {
      logError(`staff email dropped: the ${taken.reason}'s limit is used up`, {
        audit: auditId,
      });
      return result(auditId, "cap-hit");
    }

    const sent = await ports.send(to, input.mail, auditId);
    if (!sent.ok) {
      await ports.release(caller, { day: taken.day, month: taken.month });
      logError("staff email not sent", {
        audit: auditId,
        reason: sent.reason,
        status: sent.status,
      });
      return result(auditId, "send-failed");
    }

    const marked = await ports.markNotified(caller, auditId);
    if (!marked.ok) {
      // The patient has the email; only the record of it is missing. Not retried here.
      logError("staff email sent but the audit row was not marked notified", {
        audit: auditId,
        code: marked.code,
      });
      return result(auditId, "sent", true, false);
    }
    return result(auditId, "sent", true, true);
  } catch (err) {
    logError("staff email failed", {
      audit: auditId,
      // The name of the error only: its message could carry an address or a URL.
      detail: err instanceof Error ? err.name : "unknown",
    });
    return result(auditId, "error");
  }
}
