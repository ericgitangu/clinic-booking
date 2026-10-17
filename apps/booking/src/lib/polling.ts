// The patient polling numbers, in one place so the hook and the tests agree.

/** Refetch availability this often while the tab is visible. */
export const POLL_MS = 15_000;
/** Stop polling after this long without pointer or keyboard input. */
export const IDLE_MS = 10 * 60_000;

/** The refetch interval for the current state: off once the person has gone idle. */
export const pollInterval = (idle: boolean): number | false =>
  idle ? false : POLL_MS;

/**
 * Whether a time the person had picked is gone from the latest list. An unset pick is never "taken".
 */
export const pickWasTaken = (
  picked: string,
  slots: readonly { starts_at: string }[],
): boolean => picked !== "" && !slots.some((s) => s.starts_at === picked);
