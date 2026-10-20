// The calls and the send that sendStaffEmail and sendInviteEmail make, behind an interface so the
// tests can swap any of them and the real wiring stays one small file. Server-only: it signs
// requests with the internal key and holds the Resend key.
import "server-only";
import { callApi, type ApiResult, type Caller } from "@clinic/api/call";
import {
  markNotifiedInternalAdminAuditAuditIdNotifiedPost,
  releaseEmailInternalEmailsReleasePost,
  reserveEmailInternalEmailsReservePost,
  type EmailReservation,
} from "@clinic/api/generated";
import {
  FROM_ADDRESS,
  REPLY_TO,
  SEND_TIMEOUT_MS,
  sendMail,
  type Composed,
  type SendResult,
} from "@clinic/api/mail";

export type Reservation = EmailReservation;

// The display name patients see. Pinned by a test: the address is the verified subdomain shared with
// the patient app, only the name is the admin app's own.
export const STAFF_FROM = `Idyllic Clinic <${FROM_ADDRESS}>`;

// Every outbound call in the path is bounded the same way: reserve, release, notified and the Resend
// send each give up after this long, so the whole path is at most four of them (about 20 s), and it
// runs after the response so it never delays the staff member.
export const CALL_TIMEOUT_MS = 5_000;

export type Failure = { ok: false; code: string };
export type Ok<T> = { ok: true; data: T };

export interface StaffEmailPorts {
  reserve(caller: Caller): Promise<Ok<Reservation> | Failure>;
  release(
    caller: Caller,
    taken: { day: string; month: string },
  ): Promise<Ok<true> | Failure>;
  send(to: string, mail: Composed, idempotencyKey: string): Promise<SendResult>;
  markNotified(caller: Caller, auditId: string): Promise<Ok<true> | Failure>;
}

const failure = (r: Extract<ApiResult<unknown>, { ok: false }>): Failure => ({
  ok: false,
  code: r.code,
});

export function makePorts(
  timeoutMs: number = CALL_TIMEOUT_MS,
  sendTimeoutMs: number = SEND_TIMEOUT_MS,
): StaffEmailPorts {
  return {
    async reserve(caller) {
      const r = await callApi(
        "reserveEmail",
        (client) =>
          // "other": the room EMAIL_ACK_RESERVE keeps for booking acknowledgements is not open to the
          // admin app's emails.
          reserveEmailInternalEmailsReservePost({
            client,
            query: { purpose: "other" },
          }),
        { caller, timeoutMs },
      );
      return r.ok ? { ok: true, data: r.data } : failure(r);
    },

    async release(caller, taken) {
      const r = await callApi(
        "releaseEmail",
        (client) =>
          releaseEmailInternalEmailsReleasePost({ client, body: taken }),
        { caller, timeoutMs },
      );
      return r.ok ? { ok: true, data: true } : failure(r);
    },

    send: (to, mail, idempotencyKey) =>
      sendMail(
        { from: STAFF_FROM, replyTo: REPLY_TO },
        to,
        mail,
        idempotencyKey,
        sendTimeoutMs,
      ),

    // POST /internal/admin/audit/{audit_id}/notified: the caller must be the audit row's actor
    // (the API enforces it), and a demo row cannot be marked.
    async markNotified(caller, auditId) {
      const r = await callApi(
        "markNotified",
        (client) =>
          markNotifiedInternalAdminAuditAuditIdNotifiedPost({
            client,
            path: { audit_id: auditId },
          }),
        { caller, timeoutMs },
      );
      if (!r.ok) return failure(r);
      return r.data.audit_id === auditId && r.data.notified === true
        ? { ok: true, data: true }
        : { ok: false, code: "CONTRACT_VIOLATION" };
    },
  };
}

export const defaultPorts: StaffEmailPorts = makePorts();
