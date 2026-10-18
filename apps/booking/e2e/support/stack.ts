// The real stack the end-to-end tests run against: this app built for production, the real
// FastAPI service and the real Postgres (docker compose). Nothing here is a stand-in; the one
// stand-in is Google's own sign-in, see auth.ts.
export const BASE_URL = "http://localhost:3100";

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The end-to-end tests need the compose stack: run them with \`make e2e\`.`,
    );
  }
  return value;
}

export const API = (process.env.E2E_API_URL ?? "http://127.0.0.1:8080").replace(
  /\/+$/,
  "",
);
export const AUTH_SECRET = need("BETTER_AUTH_SECRET");

export const CRON_SECRET = need("CRON_SECRET");
export const RESEND_STANDIN = "http://127.0.0.1:3198";

export interface SentEmail {
  id: string;
  to: string;
  from: string;
  reply_to: string | null;
  subject: string;
  text: string;
  html: string;
  idempotency_key: string | null;
}

// What the Resend stand-in has accepted and every attempt it saw, filtered to one recipient so that
// scenarios running in parallel never read each other's mail.
export async function mailTo(
  email: string,
): Promise<{ sent: SentEmail[]; attempts: number }> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  const res = await fetch(`${RESEND_STANDIN}/_sent`);
  const all = (await res.json()) as {
    sent: SentEmail[];
    attempts: { to: string }[];
  };
  const to = email.toLowerCase();
  return {
    sent: all.sent.filter((m) => m.to === to),
    attempts: all.attempts.filter((a) => a.to === to).length,
  };
}

export async function refuseMailTo(
  email: string,
  status = 500,
  times: number | null = null,
): Promise<void> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  await fetch(`${RESEND_STANDIN}/_fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: email, status, times }),
  });
}

// Stops refusing mail to this recipient (and only this one).
export async function allowMailTo(email: string): Promise<void> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  await fetch(`${RESEND_STANDIN}/_fail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: email, clear: true }),
  });
}

export async function runReminders(
  on?: string,
  secret: string | null = CRON_SECRET,
) {
  const url = `http://localhost:3100/cron/reminders${on ? `?on=${on}` : ""}`;
  const res = await fetch(url, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

// Makes the stand-in accept this recipient's emails and never answer them, like a Resend that hangs.
export async function hangMailTo(email: string, hang = true): Promise<void> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- loopback test stand-in
  await fetch(`${RESEND_STANDIN}/_hang`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: email, clear: !hang }),
  });
}
