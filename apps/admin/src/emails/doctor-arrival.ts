// The "patient arrived" email to the doctor, on the rails the other emails use.
//
// The API records and the web app sends (like sendStaffEmail): after an arrival is marked, the
// server action calls sendDoctorArrival inside after(), once the response is ready, so the
// arrival never waits for, or fails on, an email. In order:
//
//   1. claim the notification (POST /internal/admin/doctor-notifications/{id}/claim). The API
//      hands out the send once, with a lease, and counts the attempt; nothing to send means
//      already sent, skipped, out of attempts or held by another sender. A claim call that fails
//      is logged with its code and nothing is recorded: the row stays pending, the sheet offers a
//      resend once nothing has claimed it for a couple of minutes, and the claim is the same.
//      Every result below names the attempt the claim returned, so a sender whose lease ran out
//      cannot overwrite a newer claim.
//   2. no RESEND_API_KEY here: record it as skipped (not_configured) and stop.
//   3. reserve one email from the day's and month's allowance, the same counters acknowledgements,
//      reminders and staff emails use. A spent allowance is recorded as skipped (allowance_day or
//      allowance_month); a counter that cannot be reached fails closed and is recorded as failed
//      (it can be tried again).
//   4. send through the shared sender. Idempotency-Key = the notification's id and a short hash of
//      the address: Resend keeps a key for 24 hours and answers 409 invalid_idempotent_request when
//      it is reused with a different payload, so a repeat to the SAME address (a timeout whose
//      email did go out) returns the first result and sends nothing new, while a resend after the
//      address was corrected is a new key and is not refused.
//   5. only after the provider accepted it: record it as sent, with the provider's id (tried up to
//      three times, since the email has gone and the row must say so). A refusal, timeout or throw
//      gives the reserved unit back and records the attempt as failed.
//
// It never throws. Logs carry ids and outcomes only: no address, no name.
import "server-only";
import { createHash } from "node:crypto";
import { emailConfigured } from "@clinic/api/mail";
import { logError } from "@clinic/api/proxy/log";
import type { Caller } from "@clinic/api/call";
import type {
  DoctorNoticeFinish,
  DoctorNoticeToSend,
} from "@clinic/api/generated";
import {
  defaultPorts,
  type Failure,
  type Ok,
  type StaffEmailPorts,
} from "@/emails/ports";
import { doctorArrived } from "@/emails/templates";
import { claimDoctorNotice, finishDoctorNotice } from "@/lib/api";

/** The key Resend dedupes on (see the header): stable for one payload, new for a new address. */
export function sendKey(id: string, address: string): string {
  const hash = createHash("sha256")
    .update(address.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
  return `doctor-arrival/${id}/${hash}`;
}

export type DoctorEmailOutcome =
  | "sent"
  | "claim-failed" // the API did not answer the claim: nothing recorded, the sheet offers a resend
  | "nothing-to-send" // already sent or skipped, out of attempts, or held by another sender
  | "not-configured"
  | "cap-hit"
  | "reserve-failed"
  | "send-failed"
  | "error";

/** The two calls to the API that only this email makes; the rest are the staff email ports. */
export interface DoctorNoticePorts extends StaffEmailPorts {
  claim(
    caller: Caller,
    id: string,
  ): Promise<Ok<DoctorNoticeToSend | null> | Failure>;
  finish(
    caller: Caller,
    id: string,
    body: DoctorNoticeFinish,
  ): Promise<Ok<true> | Failure>;
}

export async function sendDoctorArrival(
  input: { caller: Caller; id: string },
  ports: DoctorNoticePorts,
): Promise<DoctorEmailOutcome> {
  const { caller, id } = input;
  let taken: { day: string; month: string } | undefined;
  let spent = false;
  try {
    const claimed = await ports.claim(caller, id);
    if (!claimed.ok) {
      logError("doctor email: the claim failed", {
        notice: id,
        code: claimed.code,
      });
      return "claim-failed";
    }
    if (claimed.data === null) return "nothing-to-send";
    const job = claimed.data;
    // A result names the attempt this claim returned. `tries` > 1 is for the one result that must
    // not be lost: the email went out.
    const finish = async (
      body: Omit<DoctorNoticeFinish, "attempt">,
      tries = 1,
    ) => {
      for (let n = 1; n <= tries; n++) {
        const r = await ports.finish(caller, id, {
          ...body,
          attempt: job.attempt,
        });
        if (r.ok) return;
        logError("doctor email: the result was not recorded", {
          notice: id,
          code: r.code,
          try: n,
        });
      }
    };

    if (!emailConfigured()) {
      await finish({ outcome: "skipped", reason: "not_configured" });
      return "not-configured";
    }

    const reserved = await ports.reserve(caller);
    if (!reserved.ok) {
      logError("doctor email dropped: the allowance could not be reserved", {
        notice: id,
        code: reserved.code,
      });
      await finish({
        outcome: "failed",
        error: "The email allowance could not be checked.",
      });
      return "reserve-failed";
    }
    if (!reserved.data.granted) {
      logError(
        `doctor email dropped: the ${reserved.data.reason}'s limit is used up`,
        { notice: id },
      );
      await finish({
        outcome: "skipped",
        reason:
          reserved.data.reason === "month"
            ? "allowance_month"
            : "allowance_day",
      });
      return "cap-hit";
    }
    taken = { day: reserved.data.day, month: reserved.data.month };

    const mail = doctorArrived({
      patientName: job.patient_name,
      doctor: job.doctor_name,
      startsAt: job.starts_at,
      timezone: job.timezone,
      appointmentId: job.appointment_id,
    });
    const sent = await ports.send(
      job.doctor_email,
      mail,
      sendKey(id, job.doctor_email),
    );
    if (!sent.ok) {
      logError("doctor email not sent", {
        notice: id,
        reason: sent.reason,
        status: sent.status,
      });
      await finish({
        outcome: "failed",
        error: `The email provider said: ${sent.reason}.`,
      });
      return "send-failed";
    }
    spent = true;
    await finish({ outcome: "sent", provider_id: sent.id }, 3);
    return "sent";
  } catch (err) {
    logError("doctor email failed", {
      notice: id,
      // The name of the error only: its message could carry an address.
      detail: err instanceof Error ? err.name : "unknown",
    });
    // Whatever was claimed is left: its lease runs out and the sheet then offers a resend.
    return spent ? "sent" : "error";
  } finally {
    if (taken && !spent) {
      try {
        const given = await ports.release(caller, taken);
        if (!given.ok)
          logError("doctor email: the reserved allowance was not given back", {
            notice: id,
            code: given.code,
          });
      } catch (err) {
        logError("doctor email: the reserved allowance was not given back", {
          notice: id,
          detail: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
}

/** The staff email ports plus the claim and finish calls, for a server action to hand in. */
export const doctorPorts = (
  base: StaffEmailPorts = defaultPorts,
): DoctorNoticePorts => ({
  ...base,
  async claim(caller, id) {
    const r = await claimDoctorNotice(caller, id);
    return r.ok ? { ok: true, data: r.data.send } : { ok: false, code: r.code };
  },
  async finish(caller, id, body) {
    const r = await finishDoctorNotice(caller, id, body);
    return r.ok ? { ok: true, data: true } : { ok: false, code: r.code };
  },
});
