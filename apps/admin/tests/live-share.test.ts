import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINGER_MS,
  SharedStream,
  type ShareChannel,
  type ShareEnv,
  type ShareLocks,
  type Stream,
} from "@/lib/live-share";
import {
  HIDDEN_CLOSE_MS,
  type LiveStatus,
  type LiveStreamOptions,
} from "@/lib/live-stream";

// Several tabs of one browser, each a SharedStream, over an in-memory lock manager and broadcast
// channel with the browser's semantics: one holder per lock name, granted in request order,
// released when the holder's promise settles or its tab closes; a message reaches every OTHER
// channel of that name, asynchronously, as a structured copy. The stream each leader would open is
// a fake the test drives. The real browser APIs are covered by the Playwright scenarios.

class Browser {
  private holder: { tab: number; release: () => void } | null = null;
  private queue: {
    tab: number;
    signal: AbortSignal;
    granted: () => Promise<void>;
    done: (v: unknown) => void;
    fail: (e: unknown) => void;
  }[] = [];
  private channels = new Set<{ tab: number; ch: ShareChannel }>();

  locks(tab: number): ShareLocks {
    return {
      request: (_name, { signal }, granted) =>
        new Promise((done, fail) => {
          const entry = { tab, signal, granted, done, fail };
          signal.addEventListener("abort", () => {
            const i = this.queue.indexOf(entry);
            if (i >= 0) {
              this.queue.splice(i, 1);
              fail(new DOMException("aborted", "AbortError"));
            }
          });
          this.queue.push(entry);
          this.grant();
        }),
    };
  }

  private grant() {
    if (this.holder || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (this.holder?.release === release) this.holder = null;
      queueMicrotask(() => this.grant());
    };
    this.holder = { tab: next.tab, release };
    void next.granted().then(
      () => {
        release();
        next.done(undefined);
      },
      () => release(),
    );
  }

  channel(tab: number): ShareChannel {
    const entry = {
      tab,
      ch: {
        onmessage: null,
        postMessage: (m: unknown) => {
          const copy = structuredClone(m);
          for (const other of this.channels) {
            if (other === entry) continue;
            queueMicrotask(() => other.ch.onmessage?.({ data: copy }));
          }
        },
        close: () => this.channels.delete(entry),
      } as ShareChannel,
    };
    this.channels.add(entry);
    return entry.ch;
  }

  /** The tab is closed: its channel goes, and the browser releases its lock. */
  close(tab: number) {
    for (const e of [...this.channels])
      if (e.tab === tab) this.channels.delete(e);
    this.queue = this.queue.filter((q) => q.tab !== tab);
    if (this.holder?.tab === tab) this.holder.release();
  }

  get leader(): number | null {
    return this.holder?.tab ?? null;
  }
}

interface FakeStream extends Stream {
  o: LiveStreamOptions;
  stopped: boolean;
  resumed: number;
}

function tab(
  browser: Browser | null,
  n: number,
  opts: { hidden?: boolean } = {},
) {
  let hidden = opts.hidden ?? false;
  let onVis: (() => void) | null = null;
  const streams: FakeStream[] = [];
  const env: ShareEnv = {
    locks: browser ? browser.locks(n) : null,
    channel: browser ? () => browser.channel(n) : null,
    isHidden: () => hidden,
    onVisibility: (cb) => {
      onVis = cb;
      return () => (onVis = null);
    },
    now: () => Date.now(),
    timers: {
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h),
    },
    stream: (o) => {
      const s: FakeStream = {
        o,
        stopped: false,
        resumed: 0,
        start: () => o.onStatus("connecting"),
        stop: () => {
          s.stopped = true;
        },
        resume: () => {
          s.resumed += 1;
        },
      };
      streams.push(s);
      return s;
    },
  };
  const share = new SharedStream("clinic-live:k", env);
  return {
    share,
    streams,
    /** The stream this tab is leading right now, if any. */
    get open() {
      const s = streams.at(-1);
      return s && !s.stopped ? s : null;
    },
    setHidden(h: boolean) {
      hidden = h;
      onVis?.();
    },
  };
}

function listener(role = "owner") {
  const events: string[] = [];
  const statuses: LiveStatus[] = [];
  const refresh = vi.fn();
  return {
    events,
    statuses,
    refresh,
    l: {
      role,
      onEvent: (id: string, event: string, _data: string, replay?: boolean) =>
        events.push(`${id}:${event}${replay ? ":replay" : ""}`),
      onStatus: (s: LiveStatus) => statuses.push(s),
      onRefresh: refresh,
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** What the gateway would send, through the leader's stream callbacks. */
function serve(s: FakeStream, role = "owner", cursor = "10.0") {
  s.o.onHello?.(cursor, JSON.stringify({ cursor, role }));
  s.o.onStatus("live");
}

describe("SharedStream: one stream per browser", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("two tabs (dashboard and an appointment) open exactly one stream, and both get every event", async () => {
    const b = new Browser();
    const dash = tab(b, 1);
    const appt = tab(b, 2);
    const d = listener();
    const a = listener();
    dash.share.subscribe(d.l);
    await flush();
    appt.share.subscribe(a.l);
    await flush();

    expect(dash.streams).toHaveLength(1);
    expect(appt.streams).toHaveLength(0);
    expect(b.leader).toBe(1);
    serve(dash.open!);
    await flush();
    dash.open!.o.onEvent("10.1", "booked", "{}");
    dash.open!.o.onEvent("10.2", "cancelled", "{}");
    await flush();
    expect(d.events).toEqual(["10.1:booked", "10.2:cancelled"]);
    expect(a.events).toEqual(["10.1:booked", "10.2:cancelled"]);
    expect(a.statuses.at(-1)).toBe("live");
  });

  it("a tab that joins late learns the state and the cursor from the leader", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    one.share.subscribe(listener().l);
    await flush();
    serve(one.open!, "owner", "20.0");
    one.open!.o.onEvent("20.5", "booked", "{}");
    await flush();

    const two = tab(b, 2);
    const late = listener();
    two.share.subscribe(late.l);
    await flush();
    expect(late.statuses.at(-1)).toBe("live");
    // A repeat of what it was told is behind the cursor: dropped.
    one.open!.o.onEvent("20.5", "booked", "{}");
    one.open!.o.onEvent("20.6", "booked", "{}");
    await flush();
    expect(late.events).toEqual(["20.6:booked"]);
  });

  it("closing the leader hands over: the next tab resumes from the last id, nothing skipped or repeated", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    const first = listener();
    const second = listener();
    one.share.subscribe(first.l);
    await flush();
    two.share.subscribe(second.l);
    await flush();
    serve(one.open!, "owner", "30.0");
    one.open!.o.onEvent("30.1", "booked", "{}");
    one.open!.o.onEvent("30.2", "booked", "{}");
    await flush();

    b.close(1);
    await flush();
    expect(b.leader).toBe(2);
    expect(two.streams).toHaveLength(1);
    expect(two.open!.o.cursor).toBe("30.2");
    // The new stream replays from 30.2 (a resume repeats nothing) and goes on.
    serve(two.open!, "owner", "30.2");
    two.open!.o.onEvent("30.2", "booked", "{}"); // a repeat, if a gateway ever sent one
    two.open!.o.onEvent("30.3", "booked", "{}");
    await flush();
    expect(second.events).toEqual([
      "30.1:booked",
      "30.2:booked",
      "30.3:booked",
    ]);
  });

  it("a page rendered for another role gets no event and is told its access changed", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    const owner = listener("owner");
    const stale = listener("viewer");
    one.share.subscribe(owner.l);
    await flush();
    two.share.subscribe(stale.l);
    await flush();
    serve(one.open!, "owner");
    one.open!.o.onEvent("10.1", "booked", '{"patient_name":"x"}');
    await flush();
    expect(owner.events).toEqual(["10.1:booked"]);
    expect(stale.events).toEqual([]);
    expect(stale.statuses.at(-1)).toBe("denied");
  });

  it("busy: every tab refreshes on the leader's 30 s clock", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    const x = listener();
    const y = listener();
    one.share.subscribe(x.l);
    await flush();
    two.share.subscribe(y.l);
    await flush();
    one.open!.o.onStatus("busy");
    one.open!.o.onRefresh();
    await flush();
    expect(y.statuses.at(-1)).toBe("busy");
    expect(x.refresh).toHaveBeenCalledTimes(1);
    expect(y.refresh).toHaveBeenCalledTimes(1);
  });

  it("resume from a follower reaches the leader's stream", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    one.share.subscribe(listener().l);
    await flush();
    two.share.subscribe(listener().l);
    await flush();
    one.open!.o.onStatus("paused");
    await flush();
    two.share.resume();
    await flush();
    expect(one.open!.resumed).toBe(1);
  });

  it("a leader hidden for five minutes lets go, and a visible tab takes over from its cursor", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    one.share.subscribe(listener().l);
    await flush();
    two.share.subscribe(listener().l);
    await flush();
    serve(one.open!, "owner", "40.0");
    one.open!.o.onEvent("40.1", "booked", "{}");
    await flush();

    one.setHidden(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS - 1000);
    expect(b.leader).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(one.streams[0].stopped).toBe(true);
    expect(b.leader).toBe(2);
    expect(two.open!.o.cursor).toBe("40.1");

    // Back to the first tab: it does not take the lock away; it follows.
    one.setHidden(false);
    await flush();
    expect(b.leader).toBe(2);
    expect(one.streams).toHaveLength(1);
  });

  it("with every tab hidden there is no stream; the first tab looked at opens it again", async () => {
    const b = new Browser();
    const one = tab(b, 1);
    const two = tab(b, 2);
    const seen = listener();
    one.share.subscribe(listener().l);
    await flush();
    two.share.subscribe(seen.l);
    await flush();
    serve(one.open!, "owner", "50.0");
    one.open!.o.onEvent("50.4", "booked", "{}");
    await flush();
    two.setHidden(true);
    one.setHidden(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(one.open).toBeNull();
    expect(b.leader).toBeNull();
    expect(seen.statuses.at(-1)).toBe("paused");

    two.setHidden(false);
    await flush();
    expect(b.leader).toBe(2);
    expect(two.open!.o.cursor).toBe("50.4");
  });

  it("a tab opened in the background opens no stream until it is looked at", async () => {
    const b = new Browser();
    const bg = tab(b, 1, { hidden: true });
    const l = listener();
    bg.share.subscribe(l.l);
    await flush();
    expect(bg.streams).toHaveLength(0);
    expect(l.statuses.at(-1)).toBe("paused");
    bg.setHidden(false);
    await flush();
    expect(bg.streams).toHaveLength(1);
  });

  it("keeps the stream across a page change in the same tab, and lets go once nothing listens", async () => {
    const b = new Browser();
    const t = tab(b, 1);
    const off = t.share.subscribe(listener().l);
    await flush();
    off(); // the dashboard unmounts...
    await vi.advanceTimersByTimeAsync(500);
    const off2 = t.share.subscribe(listener().l); // ...and the appointment page mounts
    await vi.advanceTimersByTimeAsync(LINGER_MS * 2);
    expect(t.streams).toHaveLength(1);
    expect(t.open).not.toBeNull();
    off2();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(t.open).toBeNull();
    expect(b.leader).toBeNull();
  });

  it("ignores a malformed message from another tab", async () => {
    const b = new Browser();
    const t = tab(b, 1);
    const other = tab(b, 2);
    const l = listener();
    other.share.subscribe(listener().l);
    await flush();
    t.share.subscribe(l.l);
    await flush();
    serve(other.open!);
    await flush();
    const rogue = b.channel(9);
    rogue.postMessage({
      t: "event",
      id: "1.2; DROP",
      event: "booked",
      data: "{}",
    } as never);
    rogue.postMessage({ t: "status", status: "pwned" } as never);
    rogue.postMessage({ t: "event", id: "99.1", event: "booked" } as never);
    await flush();
    expect(l.events).toEqual([]);
    expect(l.statuses.at(-1)).toBe("live");
  });

  it("without Web Locks or BroadcastChannel each tab holds its own stream, as before", async () => {
    const t = tab(null, 1);
    const l = listener();
    t.share.subscribe(l.l);
    await flush();
    expect(t.streams).toHaveLength(1);
    serve(t.open!);
    t.open!.o.onEvent("10.1", "booked", "{}");
    expect(l.events).toEqual(["10.1:booked"]);
    t.setHidden(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(t.open).toBeNull();
    expect(l.statuses.at(-1)).toBe("paused");
    t.setHidden(false);
    await flush();
    expect(t.open!.o.cursor).toBe("10.1");
  });
});

describe("SharedStream: replayed events keep their flag", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a replay is marked for the leader and for a follower tab, and a live event after it is not", async () => {
    const b = new Browser();
    const lead = tab(b, 1);
    const follow = tab(b, 2);
    const l = listener();
    const f = listener();
    lead.share.subscribe(l.l);
    await flush();
    follow.share.subscribe(f.l);
    await flush();
    serve(lead.open!);
    await flush();
    lead.open!.o.onEvent("10.1", "booked", "{}", true);
    lead.open!.o.onEvent("10.2", "booked", "{}", false);
    await flush();
    expect(l.events).toEqual(["10.1:booked:replay", "10.2:booked"]);
    expect(f.events).toEqual(["10.1:booked:replay", "10.2:booked"]);
  });
});
