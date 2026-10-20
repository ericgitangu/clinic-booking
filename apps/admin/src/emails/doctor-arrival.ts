// The "patient arrived" email to the doctor, on the rails the other emails use.
//
// The API records and the web app sends (like sendStaffEmail): after an arrival is marked, the
// server action calls sendDoctorArrival inside after(), once the response is ready, so the
// arrival never waits for, or fails on, an email. In order:
//
//   1. claim the notification (POST /internal/admin/doctor-notifications/{id}/claim). The API
//      hands out the send once, with a lease, and counts the attempt; nothing to send means
//      already sent, skipped, out of attempts or held by another sender.
//   2. no RESEND_API_KEY here: record it as skipped (not_configured) and stop.
//   3. reserve one email from the day's and month's allowance, the same counters acknowledgements,
//      reminders and staff emails use. A spent allowance is recorded as skipped (allowance_day or
//      allowance_month); a counter that cannot be reached fails closed and is recorded as failed
//      (it can be tried again).
//   4. send through the shared sender (Idempotency-Key = the notification's id, so a repeat after a
//      timeout never makes a second email).
//   5. only after the provider accepted it: record it as sent, with the provider's id. A refusal,
//      timeout or throw gives the reserved unit back and records the attempt as failed.
//
// It never throws. Logs carry ids and outcomes only: no address, no name.
import "server-only";
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

export type DoctorEmailOutcome =
  | "sent"
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
  const finish = async (body: DoctorNoticeFinish) => {
    const r = await ports.finish(caller, id, body);
    if (!r.ok)
      logError("doctor email: the result was not recorded", {
        notice: id,
        code: r.code,
      });
  };
  try {
    const claimed = await ports.claim(caller, id);
    if (!claimed.ok || claimed.data === null) return "nothing-to-send";
    const job = claimed.data;

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
      `doctor-arrival/${id}`,
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
    await finish({ outcome: "sent", provider_id: sent.id });
    return "sent";
  } catch (err) {
    logError("doctor email failed", {
      notice: id,
      // The name of the error only: its message could carry an address.
      detail: err instanceof Error ? err.name : "unknown",
    });
    if (!spent) {
      try {
        await finish({ outcome: "failed", error: "Unexpected error." });
      } catch {
        // recorded in the log above; the lease runs out and the row can be claimed again
      }
    }
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
