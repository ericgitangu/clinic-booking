// The one place an email is handed to Resend, shared by the patient app and the admin app so the
// guards (timeout, redaction, no logging of addresses or the key) exist exactly once. Each app
// supplies its own display name and passes it in; the address and domain are fixed here so the two
// cannot drift apart.
//
// Email is sent from the verified subdomain, not the root domain: Resend only sends from a domain
// verified in its dashboard (mail.ericgitangu.com is the verified one), and keeping mail on a
// subdomain protects the root domain's reputation.
import { logError } from "./proxy/log";

export const MAIL_DOMAIN = "mail.ericgitangu.com";
export const FROM_ADDRESS = `reminders@${MAIL_DOMAIN}`;
// Replies go to the engineer's own address.
export const REPLY_TO = "developer.ericgitangu@gmail.com";

export interface Composed {
  subject: string;
  html: string;
  text: string;
}

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

// Resend's own words for why it refused, for the log: any email address in them is replaced, the API
// key is never shown even if it were echoed back, and the line is cut at 200 characters. The request
// (addresses, subject, body) and the key are never logged.
export function describeRefusal(
  message: unknown,
  key: string,
): string | undefined {
  if (typeof message !== "string" || message === "") return undefined;
  return message
    .split(key)
    .join("<redacted>")
    .replace(/[^\s<>"'`,;()]+@[^\s<>"'`,;()]*[^\s<>"'`,;().]/g, "<redacted>")
    .slice(0, 200);
}

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

export interface Sender {
  /** The full From header value, e.g. `Idyllic Clinic <reminders@mail.ericgitangu.com>`. */
  from: string;
  replyTo: string;
}

// One email through Resend, with the idempotency key that makes a repeat return the first result
// instead of sending again. `ok` means Resend answered 2xx: only then is the email sent. Never
// throws, and never waits longer than the timeout.
export async function sendMail(
  sender: Sender,
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
        from: sender.from,
        to,
        reply_to: sender.replyTo,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json().catch(() => null)) as {
      id?: string;
      name?: string;
      message?: string;
    } | null;
    if (!res.ok || !body?.id) {
      logError("email rejected", {
        status: res.status,
        name: body?.name,
        detail: describeRefusal(body?.message, key),
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
