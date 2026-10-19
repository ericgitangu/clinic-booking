import "server-only";
import {
  describeRefusal,
  emailConfigured,
  SEND_TIMEOUT_MS,
  sendMail,
  type SendResult,
} from "@clinic/api/mail";
import type { Composed } from "@/lib/email/compose";

import { FROM, REPLY_TO } from "@/lib/email/sender";

// The transport itself (timeout, redaction of Resend's refusals, the not-configured note) lives in
// @clinic/api/mail, shared with the admin app. This keeps the patient app's names and signature.
export { FROM, REPLY_TO, SEND_TIMEOUT_MS, describeRefusal, emailConfigured };
export type { SendResult };

// One email through Resend as "Idyllic Clinic", with the idempotency key that makes a repeat
// return the first result instead of sending again. Never throws, and never waits longer than the
// timeout.
export const sendEmail = (
  to: string,
  mail: Composed,
  idempotencyKey: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> =>
  sendMail(
    { from: FROM, replyTo: REPLY_TO },
    to,
    mail,
    idempotencyKey,
    timeoutMs,
  );
