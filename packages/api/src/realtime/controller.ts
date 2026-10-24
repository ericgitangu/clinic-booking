// The client side of a push channel, with no framework in it: mint a token, open the event stream
// with fetch (so the token travels in an Authorization header and a refused or expired token can be
// read, which the native EventSource cannot do), parse frames, and reconnect with a capped backoff.
// Every decision about *when* to reconnect belongs to the caller (`shouldReconnect`), so an idle or
// hidden page never mints tokens.
import { createSseParser } from "./sse";

export type StreamStatus =
  | "off" // not started
  | "connecting"
  | "live" // the stream is open and the service has not refused it
  | "polling" // push is unavailable right now; the caller polls
  | "refused"; // the service or the token endpoint said no (rate limit, no access); the caller polls

export type MintedToken = { token: string; streamUrl: string };

/** What `getToken` throws when it cannot mint. */
export class TokenError extends Error {
  constructor(
    readonly kind: "rate_limited" | "unavailable" | "failed",
    readonly retryAfterMs = 0,
  ) {
    super(`token ${kind}`);
  }
}

export interface Parseable<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

export interface ControllerOptions<T> {
  getToken(signal: AbortSignal): Promise<MintedToken>;
  schema: Parseable<T>;
  onEvent(event: T, id: string): void;
  onStatus(status: StreamStatus): void;
  /** Called after every successful (re)connect: the service documents no signal for a failed resume. */
  onConnected?(): void;
  /** Visible, not idle, and the person has done something since the last token was minted. */
  shouldReconnect(): boolean;
  fetchImpl?: typeof fetch;
  /**
   * How long to wait for the first SSE frame before calling the stream live. The service sends no
   * frame on connect (see the backend's real-Ably test), so a page that books immediately after
   * the headers can publish before the subscription is attached and lose the event. A first frame
   * is positive proof; after this grace the stream is treated as live anyway. Default 1.5 s.
   */
  attachGraceMs?: number;
  /** Reconnect backoff in ms: doubles from `baseMs` up to `maxMs`. */
  backoff?: { baseMs: number; maxMs: number };
  /** How long to leave a refused (429, no access) channel alone. */
  refusedWaitMs?: number;
}

const TOKEN_CODES = (c: number) => c >= 40140 && c < 40150;
const NO_ACCESS = 40160;

export class StreamController<T> {
  private abort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private stopped = true;
  private status: StreamStatus = "off";
  private mints = 0;

  constructor(private readonly o: ControllerOptions<T>) {}

  get mintCount() {
    return this.mints;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    void this.run(this.abort.signal);
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.wake?.();
    this.set("off");
  }

  /** Something that may allow a reconnect changed (the page became visible, the person acted). */
  poke() {
    this.wake?.();
  }

  private set(s: StreamStatus) {
    if (this.status === s) return;
    this.status = s;
    this.o.onStatus(s);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wake = null;
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wake = done;
      signal.addEventListener("abort", done);
    });
  }

  private async run(signal: AbortSignal) {
    const { baseMs, maxMs } = this.o.backoff ?? { baseMs: 2000, maxMs: 60_000 };
    let failures = 0;
    let first = true;
    while (!signal.aborted) {
      if (!first && !this.o.shouldReconnect()) {
        this.set("polling");
        await this.sleep(30_000, signal);
        continue;
      }
      first = false;
      this.set("connecting");
      let minted: MintedToken;
      try {
        this.mints += 1;
        minted = await this.o.getToken(signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TokenError && err.kind === "rate_limited") {
          this.set("refused");
          await this.sleep(
            Math.max(err.retryAfterMs, this.o.refusedWaitMs ?? 60_000),
            signal,
          );
        } else if (err instanceof TokenError && err.kind === "unavailable") {
          this.set("polling"); // push is off (not configured, or the month's budget is spent)
          await this.sleep(
            Math.max(err.retryAfterMs, this.o.refusedWaitMs ?? 60_000),
            signal,
          );
        } else {
          this.set("polling");
          await this.sleep(Math.min(baseMs * 2 ** failures++, maxMs), signal);
        }
        continue;
      }
      const outcome = await this.read(minted, signal);
      if (signal.aborted) return;
      if (outcome === "opened-then-closed") {
        failures = 0;
        this.set("polling");
        continue; // the token expired or the link dropped: decide again, mint again if allowed
      }
      if (outcome === "refused") {
        this.set("refused");
        await this.sleep(this.o.refusedWaitMs ?? 60_000, signal);
        continue;
      }
      this.set("polling");
      await this.sleep(Math.min(baseMs * 2 ** failures++, maxMs), signal);
    }
  }

  private async read(
    t: MintedToken,
    signal: AbortSignal,
  ): Promise<"opened-then-closed" | "refused" | "failed"> {
    const doFetch = this.o.fetchImpl ?? fetch;
    let outcome: "opened-then-closed" | "refused" | "failed" = "failed";
    try {
      // No `cache` option: it adds Cache-Control and Pragma request headers, which turns a plain
      // cross-origin GET into one that needs a CORS preflight allowing them.
      const res = await doFetch(t.streamUrl, {
        headers: {
          Authorization: `Bearer ${t.token}`,
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!res.ok || !res.body) return "failed";
      outcome = "opened-then-closed";
      let failed = false;
      let marked = false;
      const markLive = () => {
        if (marked || failed || signal.aborted) return;
        marked = true;
        this.set("live");
        this.o.onConnected?.();
      };
      const parser = createSseParser((f) => {
        if (f.kind === "event" && f.event === "error") {
          failed = true;
          let code = 0;
          try {
            code = Number((JSON.parse(f.data) as { code?: number }).code);
          } catch {
            /* an error frame we cannot read is a service problem */
          }
          outcome =
            code === NO_ACCESS
              ? "refused"
              : TOKEN_CODES(code)
                ? "opened-then-closed"
                : "failed";
          this.set(outcome === "refused" ? "refused" : "polling");
          void reader.cancel();
          return;
        }
        // A comment, heartbeat or real event is positive proof the subscription is attached.
        markLive();
        if (f.kind === "event") this.deliver(f.data);
      });
      const reader = res.body.getReader();
      const timer = setTimeout(markLive, this.o.attachGraceMs ?? 1_500);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(value);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      if (signal.aborted) return outcome;
    }
    return outcome;
  }

  private deliver(data: string) {
    let msg: { id?: string; data?: unknown };
    try {
      msg = JSON.parse(data) as { id?: string; data?: unknown };
    } catch {
      return;
    }
    let payload = msg.data;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    const parsed = this.o.schema.safeParse(payload);
    if (parsed.success) this.o.onEvent(parsed.data, String(msg.id ?? ""));
  }
}
