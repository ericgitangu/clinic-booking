// The browser side of the live feed, with no framework in it.
//
// It reads the admin app's own stream route with fetch (the native EventSource cannot tell a
// refused stream from a dropped one), resumes from the last event it saw, and decides when NOT to
// hold a connection open, because an open stream is the one thing that costs compute:
//
// - the server closes every stream itself (a lifetime, an idle limit); this client reconnects after
//   a lifetime or shutdown close and does NOT after an idle close (that waits for the person);
// - a tab hidden for HIDDEN_CLOSE_MS closes its stream and resumes when it is visible again;
// - a refused stream (the gateway has no free slot, or is unavailable) falls back to refreshing the
//   page's numbers every BUSY_REFRESH_MS and tries the stream again with a growing, jittered delay
//   (BUSY_RETRY_BASE_MS doubling up to BUSY_RETRY_MAX_MS, never sooner than Retry-After).
//
// One browser holds one of these at a time: live-share.ts elects a leader tab that owns it and
// passes its events to the other tabs.
import { createSseParser } from "@clinic/api/realtime";

export type LiveStatus =
  | "connecting"
  | "live"
  | "paused" // the server closed an idle stream, or the tab was hidden for a while
  | "busy" // no free slot or the gateway is unavailable: refreshing instead
  | "offline" // a network failure: retrying
  | "denied"; // the role changed or access was revoked

type Handle = ReturnType<typeof setTimeout>;

export const HIDDEN_CLOSE_MS = 5 * 60_000;
export const BUSY_REFRESH_MS = 30_000;
export const BUSY_RETRY_BASE_MS = 30_000;
export const BUSY_RETRY_MAX_MS = 4 * 60_000;
/**
 * An older gateway sends no `replay_tag: true` in its hello frame and never tags its backlog, so
 * the absence of a tag would read as "live" and a resumed stream would toast the whole backlog.
 * Against such a gateway only (the admin app can ship before the gateway does), a resumed stream
 * treats frames as backlog until one arrives more than this long after the one before it (the
 * gateway polls every second). It is a heuristic, kept for that case alone; a gateway that says it
 * tags is trusted and this is never used.
 */
export const LEGACY_CATCHUP_QUIET_MS = 1500;

export interface LiveStreamOptions {
  /**
   * Called with each event frame's SSE id, event name and data. `replay` is true for a frame that
   * is part of the backlog the gateway sent after a resume: the gateway tags those frames itself
   * (`replay: true`) and this trusts that tag alone. Frames it does not tag are live.
   */
  onEvent(id: string, event: string, data: string, replay?: boolean): void;
  onStatus(status: LiveStatus): void;
  /** Refresh the page's numbers by other means (the fallback while the stream is unavailable). */
  onRefresh(): void;
  /** The stream's hello frame: its cursor and the role the gateway serves (from the database). */
  onHello?(id: string, data: string): void;
  /** Where to read from; defaults to the admin app's own route. */
  url?: string;
  /** Resume from here on the first connection (a new leader tab continues where the last left). */
  cursor?: string | null;
  /** Milliseconds, for the legacy catch-up rule; Date.now by default. */
  now?: () => number;
  /** 0..1, for the busy retry's jitter; Math.random by default. */
  random?: () => number;
  fetchImpl?: typeof fetch;
  isHidden?: () => boolean;
  timers?: {
    setTimeout: (f: () => void, ms: number) => Handle;
    clearTimeout: (h: Handle) => void;
  };
  /** Reconnect backoff for network failures. */
  backoff?: { baseMs: number; maxMs: number };
}

export class LiveStream {
  private abort: AbortController | null = null;
  private lastId: string | null = null;
  private status: LiveStatus = "connecting";
  private stopped = true;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedByHidden = false;
  private failures = 0;
  private busyStreak = 0;
  private droppedCursor = false;
  /** Counts connection attempts, so a test (or a trace) can see that a hidden tab opened none. */
  attempts = 0;

  constructor(private readonly o: LiveStreamOptions) {
    this.lastId = o.cursor ?? null;
  }

  /** The last event id seen: where a reconnect, or the next leader, resumes from. */
  get cursor(): string | null {
    return this.lastId;
  }

  private t() {
    return (
      this.o.timers ?? {
        setTimeout: (f: () => void, ms: number): Handle => setTimeout(f, ms),
        clearTimeout: (h: Handle) => clearTimeout(h),
      }
    );
  }

  get current(): LiveStatus {
    return this.status;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.clearTimers();
  }

  /** The person asked to go live again (after an idle pause). */
  resume() {
    if (this.stopped) return;
    if (this.status === "live" || this.status === "connecting") return;
    this.clearTimers();
    void this.connect();
  }

  /** document.visibilitychange. */
  visibilityChanged() {
    if (this.stopped) return;
    const hidden = this.o.isHidden?.() ?? false;
    if (hidden) {
      if (this.hiddenTimer === null && this.status === "live") {
        this.hiddenTimer = this.t().setTimeout(() => {
          this.hiddenTimer = null;
          this.abort?.abort();
          this.pausedByHidden = true;
          this.set("paused");
        }, HIDDEN_CLOSE_MS);
      }
      return;
    }
    if (this.hiddenTimer !== null) {
      this.t().clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.pausedByHidden) {
      this.pausedByHidden = false;
      this.resume();
    }
  }

  private set(s: LiveStatus) {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus(s);
  }

  private clearTimers() {
    for (const h of [this.hiddenTimer, this.retryTimer, this.refreshTimer]) {
      if (h !== null) this.t().clearTimeout(h);
    }
    this.hiddenTimer = this.retryTimer = this.refreshTimer = null;
  }

  private startRefreshing() {
    if (this.refreshTimer !== null) return;
    const tick = () => {
      this.o.onRefresh();
      this.refreshTimer = this.t().setTimeout(tick, BUSY_REFRESH_MS);
    };
    this.refreshTimer = this.t().setTimeout(tick, BUSY_REFRESH_MS);
  }

  private stopRefreshing() {
    if (this.refreshTimer !== null) this.t().clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private later(ms: number) {
    if (this.stopped) return;
    this.retryTimer = this.t().setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, ms);
  }

  private async connect() {
    if (this.stopped) return;
    if (this.o.isHidden?.() && this.lastId !== null) {
      // Do not open a stream for a tab nobody is looking at; visibilityChanged resumes it.
      this.pausedByHidden = true;
      this.set("paused");
      return;
    }
    this.attempts += 1;
    this.set("connecting");
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const doFetch = this.o.fetchImpl ?? fetch;
    const base = this.o.url ?? "/live/stream";
    const query = new URLSearchParams();
    if (this.lastId) query.set("cursor", this.lastId);
    const qs = query.toString();
    const url = qs ? `${base}?${qs}` : base;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: "text/event-stream" },
        signal,
      });
    } catch {
      if (signal.aborted || this.stopped) return;
      this.network();
      return;
    }
    if (res.status === 401 || res.status === 403) {
      this.set("denied");
      return;
    }
    if (res.status === 400 && this.lastId !== null && !this.droppedCursor) {
      // The gateway will not resume from this cursor: start fresh, once. The page refreshes its
      // numbers so nothing missed in between stays missing.
      this.droppedCursor = true;
      this.lastId = null;
      this.o.onRefresh();
      void this.connect();
      return;
    }
    if (res.status === 400) {
      // Refused without a cursor to drop (a filter the gateway will not take): retrying would
      // repeat the same request, so stop.
      this.set("denied");
      return;
    }
    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      this.set("busy");
      this.startRefreshing();
      this.later(this.busyDelay(res.headers.get("retry-after")));
      return;
    }
    if (!res.ok || !res.body) {
      this.network();
      return;
    }
    this.failures = 0;
    this.busyStreak = 0;
    this.droppedCursor = false;
    this.stopRefreshing();
    this.set("live");

    let closeReason: string | null = null;
    // Against a gateway that does not say it tags its backlog (see LEGACY_CATCHUP_QUIET_MS).
    const resuming = this.lastId !== null;
    const now = this.o.now ?? Date.now;
    let legacyCatchUp = false;
    let lastFrameAt = now();
    const parser = createSseParser((f) => {
      if (f.kind !== "event") return;
      if (f.id) this.lastId = f.id;
      const at = now();
      const quiet = at - lastFrameAt > LEGACY_CATCHUP_QUIET_MS;
      lastFrameAt = at;
      if (f.event === "hello") {
        legacyCatchUp = resuming && !tagsItsBacklog(f.data);
        this.o.onHello?.(f.id ?? "", f.data);
        return;
      }
      if (f.event === "reconnect" || f.event === "idle") {
        closeReason = f.event === "idle" ? "idle" : this.reason(f.data);
        return;
      }
      if (legacyCatchUp && quiet) legacyCatchUp = false;
      this.o.onEvent(f.id ?? "", f.event, f.data, f.replay || legacyCatchUp);
    });
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch {
      if (signal.aborted || this.stopped) return;
    }
    if (signal.aborted || this.stopped) return;

    if (closeReason === "idle") {
      this.set("paused"); // wait for the person; nothing reconnects by itself
      return;
    }
    // A lifetime, shutdown or access change: reconnect at once, from the last event seen.
    void this.connect();
  }

  private reason(data: string): string {
    try {
      return String((JSON.parse(data) as { reason?: string }).reason ?? "");
    } catch {
      return "";
    }
  }

  /** 30 s, 60 s, 120 s, 240 s, then 240 s: +-20 % so two refused browsers do not retry in step. */
  private busyDelay(retryAfter: string | null): number {
    const told = Number(retryAfter) * 1000;
    const floor = Number.isFinite(told) && told > 0 ? told : 0;
    const step = Math.min(
      BUSY_RETRY_BASE_MS * 2 ** this.busyStreak++,
      BUSY_RETRY_MAX_MS,
    );
    const jitter = 0.8 + 0.4 * (this.o.random ?? Math.random)();
    return Math.max(floor, Math.round(step * jitter));
  }

  private network() {
    this.set("offline");
    this.startRefreshing();
    const { baseMs, maxMs } = this.o.backoff ?? { baseMs: 2000, maxMs: 30_000 };
    this.later(Math.min(baseMs * 2 ** this.failures++, maxMs));
  }
}

/** Whether the hello frame says this gateway tags the backlog of a resumed stream. */
function tagsItsBacklog(data: string): boolean {
  try {
    return (JSON.parse(data) as { replay_tag?: unknown }).replay_tag === true;
  } catch {
    return false;
  }
}
