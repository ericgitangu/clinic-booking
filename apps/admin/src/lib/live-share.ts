// One live stream per browser, shared by every tab and every view of the admin app.
//
// The gateway can hold two streams in the whole system (two Cloud Run instances, one stream
// each), so a person with the dashboard in one tab and an appointment in another must not take
// both. The tabs of one browser elect a leader with the Web Locks API: the tab holding the lock
// owns the only LiveStream and re-broadcasts what it reads over a BroadcastChannel; the others
// listen. When the leader tab closes the browser releases the lock and the next tab waiting for it
// takes over, resuming from the last event id it heard, so nothing is skipped; an id at or before
// the last one seen is dropped, so nothing is delivered twice.
//
// Hidden tabs keep the old rule: a leader hidden for HIDDEN_CLOSE_MS lets go of the stream (and the
// lock, so a visible tab can lead), and a hidden tab never queues for the lock. With no tab visible
// there is no stream.
//
// The stream survives the page that started it for LINGER_MS, so going from the dashboard to an
// appointment and back (client-side navigation) keeps the same stream instead of abandoning one.
// That matters on Cloud Run, which does not tell the gateway that a client left: an abandoned
// stream holds its instance until the gateway's own idle close.
//
// What a tab is given is exactly what the gateway sent for the person's current role. The stream
// says which role it serves (its hello frame, from the database); a page rendered for another role
// is told its access changed and is given no event. Without Web Locks or BroadcastChannel each tab
// holds its own stream, as before.
import { after } from "@/lib/live-events";
import {
  HIDDEN_CLOSE_MS,
  LiveStream,
  type LiveStatus,
  type LiveStreamOptions,
} from "@/lib/live-stream";

export const LINGER_MS = 15_000;

export interface LiveListener {
  /** The role the page was rendered for. */
  role: string;
  /** `replay`: part of the catch-up after a resume (see live-stream.ts), not a live event. */
  onEvent(id: string, event: string, data: string, replay?: boolean): void;
  onStatus(status: LiveStatus): void;
  /** Refresh the page's data by other means (the busy fallback, or a dropped cursor). */
  onRefresh(): void;
}

type Message =
  | { t: "event"; id: string; event: string; data: string; replay?: boolean }
  | { t: "hello"; id: string; role: string }
  | { t: "status"; status: LiveStatus }
  | { t: "refresh" }
  | { t: "resume" }
  | { t: "hi" };

export interface ShareChannel {
  postMessage(m: Message): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

export interface ShareLocks {
  request(
    name: string,
    options: { signal: AbortSignal },
    granted: () => Promise<void>,
  ): Promise<unknown>;
}

type Handle = ReturnType<typeof setTimeout>;

export interface Stream {
  start(): void;
  stop(): void;
  resume(): void;
}

export interface ShareEnv {
  /** Both or neither: without either, every tab leads its own stream. */
  locks: ShareLocks | null;
  channel: ((name: string) => ShareChannel) | null;
  isHidden(): boolean;
  onVisibility(cb: () => void): () => void;
  now(): number;
  timers: {
    setTimeout: (f: () => void, ms: number) => Handle;
    clearTimeout: (h: Handle) => void;
  };
  stream(o: LiveStreamOptions): Stream;
}

const STATUSES: readonly LiveStatus[] = [
  "connecting",
  "live",
  "paused",
  "busy",
  "offline",
  "denied",
];
const SEQ = /^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})$/;

/** Another tab's message, checked field by field: anything else is ignored. */
function parse(raw: unknown): Message | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === "string";
  switch (m.t) {
    case "event":
      return str("id") &&
        SEQ.test(m.id as string) &&
        str("event") &&
        str("data") &&
        (m.replay === undefined || typeof m.replay === "boolean")
        ? (m as Message)
        : null;
    case "hello":
      return str("id") && SEQ.test(m.id as string) && str("role")
        ? (m as Message)
        : null;
    case "status":
      return STATUSES.includes(m.status as LiveStatus) ? (m as Message) : null;
    case "refresh":
    case "resume":
    case "hi":
      return m as Message;
    default:
      return null;
  }
}

function latest(a: string | null, b: string | null): string | null {
  if (!a || !SEQ.test(a)) return b;
  if (!b || !SEQ.test(b)) return a;
  return after(b, a) ? b : a;
}

function roleOf(helloData: string): string | null {
  try {
    const r = (JSON.parse(helloData) as { role?: unknown }).role;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

export class SharedStream {
  private readonly listeners = new Set<LiveListener>();
  private running = false;
  private status: LiveStatus = "connecting";
  /** The role the stream is served for, from its hello frame. */
  private role: string | null = null;
  private lastId: string | null = null;
  private leading: Stream | null = null;
  private lockRequest: AbortController | null = null;
  private releaseLock: (() => void) | null = null;
  private channel: ShareChannel | null = null;
  private offVisibility: (() => void) | null = null;
  private hiddenSince: number | null = null;
  private hiddenTimer: Handle | null = null;
  private lingerTimer: Handle | null = null;
  /** Counts the streams this tab has led, for tests and traces. */
  led = 0;

  constructor(
    private readonly name: string,
    private readonly env: ShareEnv,
  ) {}

  get current(): LiveStatus {
    return this.status;
  }

  get isLeader(): boolean {
    return this.leading !== null;
  }

  subscribe(l: LiveListener): () => void {
    this.listeners.add(l);
    if (this.lingerTimer !== null) {
      this.env.timers.clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    if (!this.running) this.begin();
    l.onStatus(this.statusFor(l));
    return () => {
      if (!this.listeners.delete(l) || this.listeners.size > 0) return;
      this.lingerTimer = this.env.timers.setTimeout(() => {
        this.lingerTimer = null;
        if (this.listeners.size === 0) this.end();
      }, LINGER_MS);
    };
  }

  /** The person asked to go live again (after an idle pause), from whichever tab. */
  resume() {
    if (!this.running) return;
    if (this.leading) {
      this.leading.resume();
      return;
    }
    this.post({ t: "resume" });
    if (!this.env.isHidden()) this.elect();
  }

  private begin() {
    this.running = true;
    this.channel = this.env.locks
      ? (this.env.channel?.(this.name) ?? null)
      : null;
    if (this.channel) {
      this.channel.onmessage = (e) => {
        const m = parse(e.data);
        if (m) this.receive(m);
      };
    }
    this.offVisibility = this.env.onVisibility(() => this.visibilityChanged());
    this.post({ t: "hi" });
    if (this.env.isHidden()) {
      // Opened in the background: no stream of its own until it is looked at. A leading tab's
      // answer to "hi" replaces this with the shared stream's state.
      this.hiddenSince = this.env.now();
      this.setStatus("paused");
      return;
    }
    this.elect();
  }

  private end() {
    this.lockRequest?.abort();
    this.abdicate();
    this.lockRequest = null;
    if (this.hiddenTimer !== null)
      this.env.timers.clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    this.offVisibility?.();
    this.offVisibility = null;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.channel = null;
    this.running = false;
    this.status = "connecting";
  }

  private elect() {
    if (!this.running || this.leading || this.lockRequest) return;
    const locks = this.env.locks;
    if (!locks || !this.channel) {
      this.lead();
      return;
    }
    const ctl = new AbortController();
    this.lockRequest = ctl;
    locks
      .request(this.name, { signal: ctl.signal }, () => {
        if (!this.running || ctl.signal.aborted || this.lockRequest !== ctl) {
          return Promise.resolve();
        }
        return new Promise<void>((release) => {
          this.releaseLock = release;
          this.lead();
        });
      })
      .catch(() => {
        // Withdrawn (the tab was hidden or the page left) before the lock was granted.
        if (this.lockRequest === ctl) this.lockRequest = null;
      });
  }

  private lead() {
    const hiddenFor =
      this.hiddenSince === null ? 0 : this.env.now() - this.hiddenSince;
    if (this.hiddenSince !== null && hiddenFor >= HIDDEN_CLOSE_MS) {
      this.abdicate("paused");
      return;
    }
    this.led += 1;
    const s = this.env.stream({
      cursor: this.lastId,
      // This class decides when a hidden tab lets go; the stream itself never pauses for it.
      isHidden: () => false,
      onHello: (id, data) => {
        this.lastId = latest(this.lastId, id);
        this.role = roleOf(data);
        if (this.role) this.post({ t: "hello", id, role: this.role });
        this.setStatus(this.status);
      },
      onEvent: (id, event, data, replay) => {
        this.post({ t: "event", id, event, data, replay: replay === true });
        this.deliver(id, event, data, replay === true);
      },
      onStatus: (status) => {
        this.post({ t: "status", status });
        this.setStatus(status);
      },
      onRefresh: () => {
        this.post({ t: "refresh" });
        this.refresh();
      },
    });
    this.leading = s;
    s.start();
    if (this.hiddenSince !== null) this.scheduleHiddenRelease(hiddenFor);
  }

  /** Stop leading; with `then`, tell every tab this is the state until someone else leads. */
  private abdicate(then?: LiveStatus) {
    if (this.leading) {
      this.leading.stop();
      this.leading = null;
    }
    if (then) {
      this.post({ t: "status", status: then });
      this.setStatus(then);
    }
    if (this.releaseLock) {
      this.releaseLock();
      this.releaseLock = null;
      this.lockRequest = null;
    }
  }

  private scheduleHiddenRelease(already: number) {
    if (this.hiddenTimer !== null) return;
    this.hiddenTimer = this.env.timers.setTimeout(
      () => {
        this.hiddenTimer = null;
        this.abdicate("paused");
      },
      Math.max(0, HIDDEN_CLOSE_MS - already),
    );
  }

  private visibilityChanged() {
    if (!this.running) return;
    if (this.env.isHidden()) {
      this.hiddenSince ??= this.env.now();
      if (this.leading) {
        this.scheduleHiddenRelease(0);
      } else if (this.lockRequest) {
        // A hidden tab does not queue to lead: a visible one should get the lock first.
        this.lockRequest.abort();
        this.lockRequest = null;
      }
      return;
    }
    this.hiddenSince = null;
    if (this.hiddenTimer !== null) {
      this.env.timers.clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    this.elect();
  }

  private receive(m: Message) {
    switch (m.t) {
      case "event":
        this.deliver(m.id, m.event, m.data, m.replay === true);
        return;
      case "hello":
        this.lastId = latest(this.lastId, m.id);
        this.role = m.role;
        this.setStatus(this.status);
        return;
      case "status":
        if (!this.leading) this.setStatus(m.status);
        return;
      case "refresh":
        this.refresh();
        return;
      case "resume":
        this.leading?.resume();
        return;
      case "hi":
        // A tab just joined: tell it where the stream is and what it serves.
        if (!this.leading) return;
        if (this.lastId && this.role)
          this.post({ t: "hello", id: this.lastId, role: this.role });
        this.post({ t: "status", status: this.status });
        return;
    }
  }

  private deliver(id: string, event: string, data: string, replay: boolean) {
    if (!SEQ.test(id)) return;
    if (this.lastId && !after(id, this.lastId)) return; // already delivered
    this.lastId = id;
    if (this.role === null) return; // no hello yet: nothing says which shape this is
    for (const l of this.listeners) {
      if (l.role === this.role) l.onEvent(id, event, data, replay);
    }
  }

  private refresh() {
    for (const l of this.listeners) l.onRefresh();
  }

  private statusFor(l: LiveListener): LiveStatus {
    return this.role !== null && l.role !== this.role ? "denied" : this.status;
  }

  private setStatus(s: LiveStatus) {
    this.status = s;
    for (const l of this.listeners) l.onStatus(this.statusFor(l));
  }

  private post(m: Message) {
    try {
      this.channel?.postMessage(m);
    } catch {
      // A closed channel (the page is unloading): the other tabs resume from their own cursor.
    }
  }
}

function browserEnv(): ShareEnv {
  const locks =
    typeof navigator !== "undefined" && navigator.locks
      ? (navigator.locks as unknown as ShareLocks)
      : null;
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? (name: string) => new BroadcastChannel(name) as unknown as ShareChannel
      : null;
  return {
    locks: locks && channel ? locks : null,
    channel: locks && channel ? channel : null,
    isHidden: () => document.hidden,
    onVisibility: (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
    now: () => Date.now(),
    timers: {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
    stream: (o) => new LiveStream(o),
  };
}

const shared = new Map<string, SharedStream>();

/** This tab's handle on the person's stream. `person` is an opaque per-person key (liveKey). */
export function sharedStream(person: string): SharedStream {
  const name = `clinic-live:${person}`;
  let s = shared.get(name);
  if (!s) {
    s = new SharedStream(name, browserEnv());
    shared.set(name, s);
  }
  return s;
}
