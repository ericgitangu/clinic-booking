import "server-only";
import { logError } from "@clinic/api/proxy/log";
import type { Appointment } from "@clinic/api/generated";
import { emailsToday, recordEmail, type Caller } from "@/lib/api";
import { compose, type Facts } from "@/lib/email/compose";
import { sendEmail } from "@/lib/email/send";
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

// Sent right after the API call succeeded, while the patient's request is still being served. It can
// never fail the booking: any problem is logged and the function returns. It counts against the
// day's email limit, and when that is used up the email is dropped and logged, never queued.
export async function acknowledge(
  kind: Kind,
  appt: Appointment,
  ctx: Context & { previousStartsAt?: string },
): Promise<void> {
  try {
    if (!process.env.RESEND_API_KEY) return;
    // Fails closed: if the day's budget cannot be read we do not send, so a broken counter can
    // never turn into unlimited email.
    const budget = await emailsToday(ctx.caller);
    if (!budget.ok) {
      logError("email dropped: the day's limit could not be read", {
        kind,
        code: budget.code,
      });
      return;
    }
    if (budget.data.remaining <= 0) {
      logError("email dropped: the day's limit is used up", { kind });
      return;
    }
    const facts: Facts = {
      kind,
      name: patientName(ctx.who),
      doctor: ctx.doctor?.full_name ?? "your doctor",
      specialty: ctx.doctor?.specialty ?? "",
      startsAt: appt.starts_at,
      previousStartsAt: ctx.previousStartsAt,
      reason: kind === "cancelled" ? appt.cancellation_reason : null,
    };
    const sent = await sendEmail(
      ctx.who.email,
      await compose(facts),
      ackKey(kind, appt),
    );
    if (sent.ok) await recordEmail(ctx.caller);
  } catch (err) {
    logError("acknowledgement failed", {
      kind,
      detail: String(err).slice(0, 160),
    });
  }
}
