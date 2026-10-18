import "server-only";
import { logError } from "@clinic/api/proxy/log";
import type { Composed } from "@/lib/email/compose";

import { FROM, REPLY_TO } from "@/lib/email/sender";

export { FROM, REPLY_TO };

// A send that has not been answered by now is given up on. Resend answers in well under a second; a
// call that hangs must not hold a function open (the acknowledgements run after the response, and
// the reminder run has a time limit). Aborting the request is the point, which is why this calls
// Resend's REST API directly (POST /emails) rather than through the SDK, which takes no abort signal.
export const SEND_TIMEOUT_MS = 5_000;

export type SendResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason: "not-configured" | "rejected" | "unreachable" | "timed-out";
      status?: number;
    };

let warned = false;

// Whether email is set up at all. When it is not (RESEND_API_KEY missing), nothing is sent and
// nothing else fails: the caller skips the email. It says so once per server instance, so the log
// shows the cause without a line for every booking.
export function emailConfigured(): boolean {
  if (process.env.RESEND_API_KEY) return true;
  if (!warned) {
    warned = true;
    logError(
      "email is not configured: RESEND_API_KEY is not set, no email is sent",
      {},
    );
  }
  return false;
}

// One email through Resend, with the idempotency key that makes a repeat return the first result
// instead of sending again. `ok` means Resend answered 2xx: only then is the email sent. Never
// throws, and never waits longer than the timeout.
export async function sendEmail(
  to: string,
  mail: Composed,
  idempotencyKey: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: "not-configured" };
  const base = (
    process.env.RESEND_BASE_URL ?? "https://api.resend.com"
  ).replace(/\/+$/, "");
  const tag = idempotencyKey.split("/")[0];
  try {
    const res = await fetch(`${base}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: FROM,
        to,
        reply_to: REPLY_TO,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as {
      id?: string;
      name?: string;
    } | null;
    if (!res.ok || !body?.id) {
      logError("email rejected", {
        status: res.status,
        name: body?.name,
        key: tag,
      });
      return { ok: false, reason: "rejected", status: res.status };
    }
    return { ok: true, id: body.id };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logError("email timed out", { after_ms: timeoutMs, key: tag });
      return { ok: false, reason: "timed-out" };
    }
    logError("email unreachable", {
      detail: String(err).slice(0, 160),
      key: tag,
    });
    return { ok: false, reason: "unreachable" };
  }
}
