import "server-only";
import { logError } from "@clinic/api/proxy/log";
import {
  claimReminders,
  markReminderSent,
  releaseEmail,
  reserveEmail,
  SYSTEM_CALLER,
} from "@/lib/api";
import { compose } from "@/lib/email/compose";
import { emailConfigured, sendEmail, type SendResult } from "@/lib/email/send";

// A run reminds at most this many people, and never more than what is left of the day (the API
// counts the acknowledgements already sent today and keeps room for later ones).
export const RUN_LIMIT = 50;

// A send that fails for a passing reason (Resend busy or down, a network blip) is tried again inside
// the run, a few times with a growing pause. The pauses and the number of retries in a whole run are
// bounded so the run always finishes inside the function's time limit. What still fails stays
// claimed under its lease and is picked up again by a later run while the appointment is ahead.
export const BACKOFF_MS = [300, 900] as const;
export const RETRY_BUDGET = 20;

// The route may run for 60 s. Each send gives up after 5 s, so a run that meets a provider that
// hangs stops starting new emails after this long and leaves the rest claimed under their lease for
// the next run.
export const RUN_DEADLINE_MS = 45_000;

export const reminderKey = (appointmentId: string, startsAt: string) =>
  `reminder/${appointmentId}/${Math.floor(Date.parse(startsAt) / 1000)}`;

export interface RunSummary {
  date: string | null;
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  /** Not started: the run ran out of time, or the day's or month's limit was reached. */
  deferred: number;
  /** Sent, but the appointment had been moved or re-claimed since: nothing was marked. */
  stale: number;
  error?: string;
}

// Worth another try: Resend answered 429 or a 5xx, or could not be reached. A 4xx (a bad address, a
// key problem) will not get better by asking again.
export function retryable(r: SendResult): boolean {
  if (r.ok) return false;
  if (r.reason === "unreachable" || r.reason === "timed-out") return true;
  return (
    r.reason === "rejected" &&
    (r.status === undefined || r.status === 429 || r.status >= 500)
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunDeps {
  send?: typeof sendEmail;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Claim, send, and only after Resend answered 2xx record it as sent.
export async function runReminders(
  on?: string,
  deps: RunDeps = {},
): Promise<RunSummary> {
  const send = deps.send ?? sendEmail;
  const sleep = deps.sleep ?? wait;
  const now = deps.now ?? Date.now;
  const started = now();
  // Without a key nothing could be sent, so claim nothing (a claim would hold every due
  // appointment under a lease for fifteen minutes for no reason) and fail the run visibly.
  if (!deps.send && !emailConfigured()) {
    return {
      date: on ?? null,
      claimed: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      deferred: 0,
      stale: 0,
      error: "not-configured",
    };
  }
  const claimed = await claimReminders(RUN_LIMIT, on);
  if (!claimed.ok) {
    logError("reminder run: claim failed", { code: claimed.code });
    return {
      date: on ?? null,
      claimed: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      deferred: 0,
      stale: 0,
      error: claimed.code,
    };
  }
  let sent = 0;
  let failed = 0;
  let stale = 0;
  let retried = 0;
  let deferred = 0;
  let stop: "deadline" | "allowance" | null = null;
  for (const r of claimed.data.items) {
    if (stop === null && now() - started > RUN_DEADLINE_MS) stop = "deadline";
    if (stop !== null) {
      deferred++; // stays claimed, so a later run takes it after the lease
      continue;
    }
    // One email from the day's and the month's allowance, before sending (and kept across the
    // retries below: they carry the same idempotency key, so Resend sends it once).
    const reserved = await reserveEmail(SYSTEM_CALLER);
    if (!reserved.ok || !reserved.data.granted) {
      stop = "allowance";
      deferred++;
      logError("reminder run stopped: no email allowance", {
        code: reserved.ok ? (reserved.data.reason ?? undefined) : reserved.code,
      });
      continue;
    }
    const taken = reserved.data;
    const mail = await compose({
      kind: "reminder",
      name: r.patient_name,
      doctor: r.doctor_name,
      specialty: r.specialty,
      startsAt: r.starts_at,
      timezone: r.timezone,
    });
    const key = reminderKey(r.appointment_id, r.starts_at);
    let result = await send(r.patient_email, mail, key);
    for (const pause of BACKOFF_MS) {
      if (!retryable(result) || retried >= RETRY_BUDGET) break;
      if (now() - started > RUN_DEADLINE_MS) break;
      retried++;
      await sleep(pause);
      // Same key: if the first try did reach Resend, this returns that answer instead of sending twice.
      result = await send(r.patient_email, mail, key);
    }
    if (!result.ok) {
      failed++;
      // Not sent, so the reserved email goes back; the appointment stays claimed under its lease.
      await releaseEmail(SYSTEM_CALLER, { day: taken.day, month: taken.month });
      continue;
    }
    const marked = await markReminderSent(r.appointment_id, {
      claimed_at: r.claimed_at,
      starts_at: r.starts_at,
    });
    if (!marked.ok) {
      failed++;
      logError("reminder sent but not recorded", { code: marked.code });
    } else if (marked.data.sent) {
      sent++;
    } else {
      stale++;
      logError("reminder sent for a claim that has since changed", {});
    }
  }
  return {
    date: claimed.data.date,
    claimed: claimed.data.items.length,
    sent,
    failed,
    retried,
    deferred,
    stale,
  };
}
