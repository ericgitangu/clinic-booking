// What to say about the email to the doctor, in plain words. Pure, so the wording is tested. The
// same status reads differently in a toast (short, after a " · ") and on the appointment sheet
// (a sentence with the time it went).
import { formatTime } from "@/lib/clinic-time";

export interface NoticeFacts {
  status: "pending" | "sent" | "failed" | "skipped";
  reason:
    | "no_email"
    | "allowance_day"
    | "allowance_month"
    | "demo_address"
    | "not_configured"
    | null;
  attempts: number;
  sentAt: string | null;
  /** Whether sending again can help now (see the API's `retryable`). */
  retryable?: boolean;
}

const WHY_SHORT: Record<NonNullable<NoticeFacts["reason"]>, string> = {
  no_email: "no doctor email",
  allowance_day: "today's email limit is used up",
  allowance_month: "this month's email limit is used up",
  demo_address: "demo address",
  not_configured: "email is not set up here",
};

const WHY_LONG: Record<NonNullable<NoticeFacts["reason"]>, string> = {
  no_email: "the doctor has no email address on file",
  allowance_day: "today's email limit was already used up",
  allowance_month: "this month's email limit was already used up",
  demo_address: "the address is a demonstration address",
  not_configured: "email is not set up in this environment",
};

/** The end of a toast: "doctor emailed", "doctor email on its way", "email not sent (no doctor email)". */
export function toastSuffix(n: NoticeFacts): string {
  switch (n.status) {
    case "sent":
      return "doctor emailed";
    case "pending":
      return n.retryable
        ? "doctor email did not go out"
        : "doctor email on its way";
    case "failed":
      return "doctor email failed";
    case "skipped":
      return `email not sent (${n.reason ? WHY_SHORT[n.reason] : "skipped"})`;
  }
}

/** The bold lead of the sheet's line. Empty for a sent email, whose line says it all. */
export function sheetLead(n: NoticeFacts): string {
  if (n.status === "sent") return "";
  return n.status === "pending" && !n.retryable
    ? "Doctor not notified yet."
    : "Doctor not notified.";
}

/**
 * The line on the appointment sheet. "Send it again." is said only when the person is being
 * offered the button for it (`canResend`: the row can be resent AND they may), so the words never
 * point at a control that is not there.
 */
export function sheetLine(n: NoticeFacts, canResend: boolean): string {
  switch (n.status) {
    case "sent":
      return n.sentAt
        ? `Doctor emailed at ${formatTime(n.sentAt)} EAT.`
        : "Doctor emailed.";
    case "pending":
      return n.retryable
        ? `The email didn't go out.${canResend ? " Send it again." : ""}`
        : "The email to the doctor is on its way.";
    case "failed":
      return `The email to the doctor could not be sent (${n.attempts} ${n.attempts === 1 ? "try" : "tries"}).${n.retryable && canResend ? " Send it again." : ""}`;
    case "skipped":
      return `The doctor was not emailed: ${n.reason ? WHY_LONG[n.reason] : "it was skipped"}.`;
  }
}

/** The confirmation for the person who marked the arrival: "Marked arrived. Doctor email on its
 *  way." The first words are always "Marked arrived." */
export function arrivalMessage(
  notice:
    Pick<NoticeFacts, "status" | "reason" | "retryable"> | null | undefined,
): string {
  if (!notice) return "Marked arrived.";
  const note = toastSuffix({ ...notice, attempts: 0, sentAt: null });
  return `Marked arrived. ${note[0].toUpperCase()}${note.slice(1)}.`;
}
