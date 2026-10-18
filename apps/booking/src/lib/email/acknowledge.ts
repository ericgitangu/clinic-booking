import "server-only";
import { logError } from "@clinic/api/proxy/log";
import type { Appointment } from "@clinic/api/generated";
import { releaseEmail, reserveEmail, type Caller } from "@/lib/api";
import { compose, type Facts } from "@/lib/email/compose";
import { emailConfigured, sendEmail } from "@/lib/email/send";
import type { Identity } from "@/lib/identity";
import { patientName } from "@/lib/identity";

type Kind = "booked" | "rescheduled" | "cancelled";

// The idempotency key: one per change to one appointment. `updated_at` moves on every change, so a
// repeat of the same request returns the first result and the next change gets a new key.
export const ackKey = (
  kind: Kind,
  appt: Pick<Appointment, "id" | "updated_at">,
) => `ack/${appt.id}/${kind}/${Date.parse(appt.updated_at)}`;

interface Context {
  caller: Caller;
  who: Identity;
  doctor: { full_name: string; specialty: string } | null;
}

// Said once per server instance and cap, so a spent allowance does not write a line per booking.
const saidSpent = new Set<string>();

// Sent after the response to the patient has gone (the caller runs it with Next's `after`), so a slow
// or hanging email provider never delays a booking, a move or a cancellation. It can never fail
// anything: any problem is logged and the function returns. One email is first reserved from the day's
// and the month's allowance (atomically in the database), and given back if the send fails; when
// either limit is used up the email is dropped and logged once, never queued.
export async function acknowledge(
  kind: Kind,
  appt: Appointment,
  ctx: Context & { previousStartsAt?: string },
): Promise<void> {
  try {
    if (!emailConfigured()) return;
    // Fails closed: if the allowance cannot be reserved we do not send, so a broken counter can
    // never turn into unlimited email.
    const reserved = await reserveEmail(ctx.caller);
    if (!reserved.ok) {
      logError("email dropped: the allowance could not be reserved", {
        kind,
        code: reserved.code,
      });
      return;
    }
    const taken = reserved.data;
    if (!taken.granted) {
      const said = `${taken.reason}:${taken.reason === "month" ? taken.month : taken.day}`;
      if (!saidSpent.has(said)) {
        saidSpent.add(said);
        logError(`email dropped: the ${taken.reason}'s limit is used up`, {
          kind,
        });
      }
      return;
    }
    const facts: Facts = {
      kind,
      name: patientName(ctx.who),
      doctor: ctx.doctor?.full_name ?? "your doctor",
      specialty: ctx.doctor?.specialty ?? "",
      startsAt: appt.starts_at,
      timezone: appt.timezone,
      previousStartsAt: ctx.previousStartsAt,
      reason: kind === "cancelled" ? appt.cancellation_reason : null,
    };
    const sent = await sendEmail(
      ctx.who.email,
      await compose(facts),
      ackKey(kind, appt),
    );
    if (!sent.ok) {
      await releaseEmail(ctx.caller, { day: taken.day, month: taken.month });
    }
  } catch (err) {
    logError("acknowledgement failed", {
      kind,
      detail: String(err).slice(0, 160),
    });
  }
}
