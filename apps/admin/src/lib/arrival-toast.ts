// The confirmation toast of the person who marked an arrival, kept up to date with what becomes of
// the email to the doctor. One toast, one id: it starts as "Marked arrived. Doctor email on its
// way." and is updated in place to "Doctor emailed.", "Email not sent (...)" or "Doctor email
// failed." If it has closed by then, the final words bring it back: this is the person's own
// action, and its outcome should not be lost silently.
import { watchDoctorNotice, type WatchOptions } from "@/lib/doctor-notice-read";
import { arrivalMessage } from "@/lib/doctor-notice-words";

export type ToastKind = "success" | "info" | "warning";

// Sonner (2.0.8, dist/index.mjs) restarts a toast's timer only when its duration CHANGES (the timer
// effect depends on the duration), so the words that wait use 17 s and the final ones 6 s: they
// differ, and every change of state starts a fresh timer. An update by id after the toast has
// closed makes a new toast with that id.
/** How long the confirmation stays while the email is still on its way (past the last look at 15 s). */
export const WAITING_MS = 17_000;
export const FINAL_MS = 6000;

export function followArrivalToast(
  appointmentId: string,
  id: string,
  show: (
    id: string,
    message: string,
    kind: ToastKind,
    durationMs: number,
  ) => void,
  options: WatchOptions = {},
): Promise<void> {
  let last = "";
  return watchDoctorNotice(
    appointmentId,
    (n) => {
      const message = arrivalMessage(n);
      if (message === last) return; // nothing new to say: leave the toast and its timer alone
      last = message;
      const final = n.status !== "pending" || n.retryable;
      const kind: ToastKind =
        n.status === "sent" || !final
          ? "success"
          : n.status === "skipped"
            ? "info"
            : "warning";
      show(id, message, kind, final ? FINAL_MS : WAITING_MS);
    },
    { done: (n) => n.status !== "pending" || n.retryable === true, ...options },
  );
}
