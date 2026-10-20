// What to say about the email to the doctor, in plain words. Pure, so the wording is tested. The
// same status reads differently in a toast (short, after a " · ") and on the appointment sheet
// (a sentence with the time it went).
import { formatSlot } from "@/lib/clinic-time";

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
      return "doctor email on its way";
    case "failed":
      return "doctor email failed";
    case "skipped":
      return `email not sent (${n.reason ? WHY_SHORT[n.reason] : "skipped"})`;
  }
}

/** The line on the appointment sheet. */
export function sheetLine(n: NoticeFacts): string {
  switch (n.status) {
    case "sent":
      return `Doctor notified by email${n.sentAt ? ` at ${formatSlot(n.sentAt)}` : ""}.`;
    case "pending":
      return "The email to the doctor is on its way.";
    case "failed":
      return `The email to the doctor could not be sent (${n.attempts} ${n.attempts === 1 ? "try" : "tries"}).`;
    case "skipped":
      return `The doctor was not emailed: ${n.reason ? WHY_LONG[n.reason] : "it was skipped"}.`;
  }
}
