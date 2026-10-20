// The Resend stand-in the admin app's server really calls over HTTP (RESEND_BASE_URL points at it;
// see playwright.config.ts). It is the one stand-in for a third party here besides Google's sign-in,
// and it is the booking suite's own (../booking/e2e/support/resend-standin.mjs), started on its own port.
export const STANDIN = `http://127.0.0.1:${process.env.ADMIN_E2E_RESEND_PORT ?? 3298}`;

export interface SentMail {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
  idempotency_key: string | null;
}

export async function mailTo(
  email: string,
): Promise<{ sent: SentMail[]; attempts: number }> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  const res = await fetch(`${STANDIN}/_sent`);
  const all = (await res.json()) as {
    sent: SentMail[];
    attempts: { to: string }[];
  };
  const to = email.toLowerCase();
  return {
    sent: all.sent.filter((m) => m.to === to),
    attempts: all.attempts.filter((a) => a.to === to).length,
  };
}

/** The provider refuses the next `times` emails to this address (500), then accepts again. */
export async function refuseMailTo(email: string, times = 1): Promise<void> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  await fetch(`${STANDIN}/_fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: email, status: 500, times }),
  });
}

export async function allowMailTo(email: string): Promise<void> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  await fetch(`${STANDIN}/_fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: email, clear: true }),
  });
}
