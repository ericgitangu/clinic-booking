// The three calls and the send that sendStaffEmail makes, behind an interface so the tests can swap
// any of them and the real wiring stays one small file. Server-only: it signs requests with the
// internal key and holds the Resend key.
import "server-only";
import { callApi, type ApiResult, type Caller } from "@clinic/api/call";
import {
  releaseEmailInternalEmailsReleasePost,
  reserveEmailInternalEmailsReservePost,
  type EmailReservation,
} from "@clinic/api/generated";
import {
  FROM_ADDRESS,
  REPLY_TO,
  sendMail,
  type Composed,
  type SendResult,
} from "@clinic/api/mail";

export type Reservation = EmailReservation;

// The display name patients see. Pinned by a test: the address is the verified subdomain shared with
// the patient app, only the name is the admin app's own.
export const STAFF_FROM = `Idyllic Clinic <${FROM_ADDRESS}>`;

type Failure = { ok: false; code: string };
type Ok<T> = { ok: true; data: T };

export interface StaffEmailPorts {
  reserve(caller: Caller): Promise<Ok<Reservation> | Failure>;
  release(caller: Caller, taken: { day: string; month: string }): Promise<void>;
  send(to: string, mail: Composed, idempotencyKey: string): Promise<SendResult>;
  markNotified(caller: Caller, auditId: string): Promise<Ok<true> | Failure>;
}

const failure = (r: Extract<ApiResult<unknown>, { ok: false }>): Failure => ({
  ok: false,
  code: r.code,
});

export const defaultPorts: StaffEmailPorts = {
  async reserve(caller) {
    const r = await callApi(
      "reserveEmail",
      (client) => reserveEmailInternalEmailsReservePost({ client }),
      { caller },
    );
    return r.ok ? { ok: true, data: r.data } : failure(r);
  },

  async release(caller, taken) {
    // Best effort: a failed release only leaves one unit of allowance used, which errs on the safe side.
    await callApi(
      "releaseEmail",
      (client) =>
        releaseEmailInternalEmailsReleasePost({ client, body: taken }),
      { caller },
    );
  },

  send: (to, mail, idempotencyKey) =>
    sendMail({ from: STAFF_FROM, replyTo: REPLY_TO }, to, mail, idempotencyKey),

  // POST /internal/admin/audit/{audit_id}/notified (backend PR #63). It goes through the
  // generic client because the generated SDK on main does not have the operation yet.
  // TODO(debt): once #63 is merged and the client regenerated, replace this body with
  // markNotifiedInternalAdminAuditAuditIdNotifiedPost({ client, path: { audit_id } }), which also
  // checks the response against the contract. Until then the response is checked by hand below.
  async markNotified(caller, auditId) {
    const r = await callApi<{ audit_id: string; notified?: boolean }>(
      "markNotified",
      (client) =>
        client.post({
          url: "/internal/admin/audit/{audit_id}/notified",
          path: { audit_id: auditId },
        }) as Promise<{
          data?: { audit_id: string; notified?: boolean };
          error?: unknown;
          response?: Response;
        }>,
      { caller },
    );
    if (!r.ok) return failure(r);
    return r.data.audit_id === auditId && r.data.notified === true
      ? { ok: true, data: true }
      : { ok: false, code: "CONTRACT_VIOLATION" };
  },
};
