// The patient polling numbers, in one place so the hook and the tests agree.

/** Refetch availability this often while the tab is visible. */
export const POLL_MS = 15_000;
/** Stop polling after this long without pointer or keyboard input. */
export const IDLE_MS = 10 * 60_000;

/** The longest wait between refetches while the API keeps failing. */
export const MAX_BACKOFF_MS = 120_000;

/**
 * The wait before the next refetch: off once the person has gone idle, POLL_MS while refreshes
 * succeed, and doubling per consecutive failure (15, 30, 60, 120 s) up to MAX_BACKOFF_MS, so an
 * API that is down is asked less often rather than as often as ever.
 */
export const pollInterval = (
  idle: boolean,
  failures = 0,
  retryAfterMs = 0,
): number | false =>
  idle
    ? false
    : Math.max(
        Math.min(POLL_MS * 2 ** Math.max(failures, 0), MAX_BACKOFF_MS),
        retryAfterMs, // the server's own minimum; the backoff is the floor under it
      );

/** The longest Retry-After honoured; a larger (or hostile) value is clamped to this. */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;

/**
 * A Retry-After header (delay in seconds, or an HTTP date) as milliseconds to wait, or null when it
 * is missing, negative or not understood. A date in the past is 0. Clamped to MAX_RETRY_AFTER_MS.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  const v = value?.trim();
  if (!v) return null;
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/^-/.test(v)) return null;
  else if (!/^[A-Za-z]{3},\s/.test(v))
    return null; // not an HTTP date either
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    ms = Math.max(at - now, 0);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Whether a time the person had picked is gone from the latest list. An unset pick is never "taken".
 */
export const pickWasTaken = (
  picked: string,
  slots: readonly { starts_at: string }[],
): boolean => picked !== "" && !slots.some((s) => s.starts_at === picked);
