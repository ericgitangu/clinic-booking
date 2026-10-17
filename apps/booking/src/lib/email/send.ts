import "server-only";
import { Resend } from "resend";
import { logError } from "@clinic/api/proxy/log";
import type { Composed } from "@/lib/email/compose";

// Idyllic Clinic Booking <reminders@ericgitangu.com>; replies go to the engineer's own address.
export const FROM = "Idyllic Clinic Booking <reminders@ericgitangu.com>";
export const REPLY_TO = "developer.ericgitangu@gmail.com";

export type SendResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "not-configured" | "rejected" | "unreachable";
      status?: number;
    };

// One email through Resend, with the idempotency key that makes a repeat return the first result
// instead of sending again. `ok` means Resend answered 2xx: only then may the caller record the
// email as sent. Never throws.
export async function sendEmail(
  to: string,
  mail: Composed,
  idempotencyKey: string,
): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: "not-configured" };
  try {
    const { data, error } = await new Resend(key).emails.send(
      {
        from: FROM,
        to,
        replyTo: REPLY_TO,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      },
      { idempotencyKey },
    );
    if (error || !data) {
      logError("email rejected", {
        status: error?.statusCode ?? undefined,
        name: error?.name,
        key: idempotencyKey.split("/")[0],
      });
      return {
        ok: false,
        reason: "rejected",
        status: error?.statusCode ?? undefined,
      };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    logError("email unreachable", {
      detail: String(err).slice(0, 160),
      key: idempotencyKey.split("/")[0],
    });
    return { ok: false, reason: "unreachable" };
  }
}
