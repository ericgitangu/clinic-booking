// The confirmation toast of the person who marked an arrival, kept up to date with what becomes of
// the email to the doctor. One toast, one id: it starts as "Marked arrived. Doctor email on its
// way." and stays up (it does not time out) while the email is pending, then is updated in place to
// "Doctor emailed.", "Email not sent (...)" or "Doctor email failed." and goes after the normal 6 s.
//
// The email is sent after the response and can take as long as the after() bound allows (about
// 25 s: claim, reserve, send and two results at 5 s each, see emails/doctor-arrival.ts), so the
// looks run to 40 s: 2.5, 6, 15, 30 and 40 s. If the last look still says pending, or none of them
// could read, the toast says so and stops: it never closes on "on its way". An update by id after
// the toast was closed makes a new toast with that id, which is wanted here: this is the person's
// own action, and its outcome should not be lost silently. Every update by id restarts sonner's
// timer (its timer effect depends on the toast object, which an update replaces; sonner 2.0.8,
// dist/index.mjs), so a finite duration on an update starts a fresh countdown; Infinity has none.
import { watchDoctorNotice, type WatchOptions } from "@/lib/doctor-notice-read";
import { arrivalMessage } from "@/lib/doctor-notice-words";

export type ToastKind = "success" | "info" | "warning";

/** Looks at 2.5, 6, 15, 30 and 40 s after the arrival: past the ~25 s the send can take. */
export const ARRIVAL_RECHECK_AFTER_MS = [
  2500, 6000, 15000, 30000, 40000,
] as const;
export const FINAL_MS = 6000;
export const WHILE_PENDING_MS = Infinity;
export const STILL_SENDING =
  "Marked arrived. The doctor email is still sending; the appointment shows the result.";

export function followArrivalToast(
  appointmentId: string,
  id: string,
  show: (
    id: string,
    message: string,
    kind: ToastKind,
    durationMs: number,
  ) => void,
  {
    initial = "",
    ...options
  }: WatchOptions & {
    /** What the toast already says, so a look that finds the same thing leaves it alone. */
    initial?: string;
  } = {},
): Promise<void> {
  let last = initial;
  let finished = false;
  return watchDoctorNotice(
    appointmentId,
    (n) => {
      const final = n.status !== "pending" || n.retryable === true;
      if (final) finished = true;
      const message = arrivalMessage(n);
      if (message === last) return; // nothing new to say: leave the toast alone
      last = message;
      const kind: ToastKind =
        n.status === "sent" || !final
          ? "success"
          : n.status === "skipped"
            ? "info"
            : "warning";
      show(id, message, kind, final ? FINAL_MS : WHILE_PENDING_MS);
    },
    {
      delays: ARRIVAL_RECHECK_AFTER_MS,
      done: (n) => n.status !== "pending" || n.retryable === true,
      ...options,
    },
  ).then(() => {
    // The looks ran out with the email still pending (or unreadable): say so, and let the toast go.
    if (!finished) show(id, STILL_SENDING, "info", FINAL_MS);
  });
}
