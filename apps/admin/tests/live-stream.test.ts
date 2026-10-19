import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_REFRESH_MS,
  BUSY_RETRY_MS,
  HIDDEN_CLOSE_MS,
  LiveStream,
  type LiveStatus,
} from "@/lib/live-stream";

// A fetch that returns a controllable event stream, so the state machine can be driven frame by
// frame. The real wire (gateway, BFF route, browser) is covered by the Playwright scenarios.
function sse() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctl = c) });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (text: string) => ctl.enqueue(enc.encode(text)),
    end: () => ctl.close(),
    abortOn(signal: AbortSignal) {
      signal.addEventListener("abort", () => {
        try {
          ctl.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      });
    },
  };
}

function setup(
  responses: (Response | "network")[],
  over: { hidden?: () => boolean; appointment?: string } = {},
) {
  const urls: string[] = [];
  const streams: ReturnType<typeof sse>[] = [];
  let i = 0;
  const fetchImpl = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(url));
      const next = responses[i++] ?? "network";
      if (next === "network") throw new TypeError("network");
      const s = streams.find((x) => x.response === next);
      s?.abortOn(init!.signal as AbortSignal);
      return next;
    },
  );
  const events: string[] = [];
  const statuses: LiveStatus[] = [];
  const refresh = vi.fn();
  const live = new LiveStream({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onEvent: (id, event) => events.push(`${id}:${event}`),
    onStatus: (s) => statuses.push(s),
    onRefresh: refresh,
    isHidden: over.hidden,
    appointment: over.appointment,
  });
  return { live, urls, events, statuses, refresh, streams };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("LiveStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes live, delivers events, and reconnects from the last id after a lifetime close", async () => {
    const a = sse();
    const b = sse();
    const t = setup([a.response, b.response]);
    t.streams.push(a, b);
    t.live.start();
    await tick();
    a.push("id: 5.0\nevent: hello\ndata: {}\n\n");
    a.push('id: 5.7\nevent: booked\ndata: {"x":1}\n\n');
    await tick();
    expect(t.live.current).toBe("live");
    expect(t.events).toEqual(["5.7:booked"]);

    a.push('event: reconnect\ndata: {"reason":"lifetime"}\n\n');
    a.end();
    await tick();
    expect(t.urls).toEqual(["/live/stream", "/live/stream?cursor=5.7"]);
    expect(t.live.current).toBe("live");
  });

  it("an idle close pauses and does not reconnect by itself; resume() does", async () => {
    const a = sse();
    const b = sse();
    const t = setup([a.response, b.response]);
    t.streams.push(a, b);
    t.live.start();
    await tick();
    a.push("id: 9.1\nevent: booked\ndata: {}\n\n");
    a.push('event: idle\ndata: {"reason":"idle"}\n\n');
    a.end();
    await tick(10 * 60_000);
    expect(t.live.current).toBe("paused");
    expect(t.live.attempts).toBe(1);
    t.live.resume();
    await tick();
    expect(t.urls[1]).toBe("/live/stream?cursor=9.1");
    expect(t.live.current).toBe("live");
  });

  it("a refused slot (429) shows busy, refreshes every 30 s, and tries again when told to", async () => {
    const busy = new Response("{}", {
      status: 429,
      headers: { "retry-after": "100" },
    });
    const ok = sse();
    const t = setup([busy, ok.response]);
    t.streams.push(ok);
    t.live.start();
    await tick();
    expect(t.live.current).toBe("busy");
    await tick(BUSY_REFRESH_MS * 3); // 30 s, 60 s, 90 s
    expect(t.refresh).toHaveBeenCalledTimes(3);
    expect(t.live.attempts).toBe(1);
    await tick(10_001); // the Retry-After of 100 s has passed
    expect(t.live.current).toBe("live");
    // once live again, the fallback refresh stops
    t.refresh.mockClear();
    await tick(BUSY_REFRESH_MS * 3);
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it("never retries sooner than a minute, whatever Retry-After says", async () => {
    const busy = new Response("{}", {
      status: 429,
      headers: { "retry-after": "1" },
    });
    const t = setup([busy, "network"]);
    t.live.start();
    await tick();
    await tick(BUSY_RETRY_MS - 1000);
    expect(t.live.attempts).toBe(1);
    await tick(1500);
    expect(t.live.attempts).toBe(2);
  });

  it("an unavailable gateway (503) is treated the same way", async () => {
    const t = setup([new Response("{}", { status: 503 })]);
    t.live.start();
    await tick();
    expect(t.live.current).toBe("busy");
  });

  it("a revoked or changed role (401/403) is denied and never retried", async () => {
    const t = setup([new Response("{}", { status: 403 })]);
    t.live.start();
    await tick(10 * 60_000);
    expect(t.live.current).toBe("denied");
    expect(t.live.attempts).toBe(1);
  });

  it("a network failure shows offline, refreshes, and retries with a growing delay", async () => {
    const ok = sse();
    const t = setup(["network", "network", ok.response]);
    t.streams.push(ok);
    t.live.start();
    await tick();
    expect(t.live.current).toBe("offline");
    await tick(2000);
    expect(t.live.attempts).toBe(2);
    await tick(4000);
    expect(t.live.attempts).toBe(3);
    expect(t.live.current).toBe("live");
    expect(t.refresh).not.toHaveBeenCalled(); // reconnected before the first 30 s refresh
  });

  it("a tab hidden for five minutes lets go of the stream and resumes when visible", async () => {
    let hidden = false;
    const a = sse();
    const b = sse();
    const t = setup([a.response, b.response], { hidden: () => hidden });
    t.streams.push(a, b);
    t.live.start();
    await tick();
    a.push("id: 3.3\nevent: booked\ndata: {}\n\n");
    await tick();

    hidden = true;
    t.live.visibilityChanged();
    await tick(HIDDEN_CLOSE_MS - 1000);
    expect(t.live.current).toBe("live");
    await tick(1500);
    expect(t.live.current).toBe("paused");
    expect(t.live.attempts).toBe(1);

    hidden = false;
    t.live.visibilityChanged();
    await tick();
    expect(t.urls[1]).toBe("/live/stream?cursor=3.3");
    expect(t.live.current).toBe("live");
  });

  it("a tab hidden for less than five minutes keeps its stream", async () => {
    let hidden = false;
    const a = sse();
    const t = setup([a.response], { hidden: () => hidden });
    t.streams.push(a);
    t.live.start();
    await tick();
    hidden = true;
    t.live.visibilityChanged();
    await tick(HIDDEN_CLOSE_MS - 60_000);
    hidden = false;
    t.live.visibilityChanged();
    await tick(HIDDEN_CLOSE_MS);
    expect(t.live.current).toBe("live");
    expect(t.live.attempts).toBe(1);
  });

  it("does not reconnect a hidden tab after a server close; it waits to be visible", async () => {
    let hidden = false;
    const a = sse();
    const b = sse();
    const t = setup([a.response, b.response], { hidden: () => hidden });
    t.streams.push(a, b);
    t.live.start();
    await tick();
    a.push("id: 4.4\nevent: booked\ndata: {}\n\n");
    await tick();
    hidden = true;
    a.push('event: reconnect\ndata: {"reason":"lifetime"}\n\n');
    a.end();
    await tick();
    expect(t.live.attempts).toBe(1);
    expect(t.live.current).toBe("paused");
    hidden = false;
    t.live.visibilityChanged();
    await tick();
    expect(t.live.attempts).toBe(2);
  });

  it("stop() ends everything: no timers, no reconnect", async () => {
    const t = setup([new Response("{}", { status: 429 })]);
    t.live.start();
    await tick();
    t.live.stop();
    await tick(10 * 60_000);
    expect(t.refresh).not.toHaveBeenCalled();
    expect(t.live.attempts).toBe(1);
  });

  it("the appointment page asks for its own appointment, and resumes with the filter kept", async () => {
    const id = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
    const a = sse();
    const b = sse();
    const t = setup([a.response, b.response], { appointment: id });
    t.streams.push(a, b);
    t.live.start();
    await tick();
    a.push("id: 5.0\nevent: hello\ndata: {}\n\n");
    a.push('event: reconnect\ndata: {"reason":"lifetime"}\n\n');
    a.end();
    await tick();
    expect(t.urls).toEqual([
      `/live/stream?appointment=${id}`,
      `/live/stream?appointment=${id}&cursor=5.0`,
    ]);
    t.live.stop();
  });

  it("a refused cursor (400) is dropped once: a fresh stream and a refresh, never a retry loop", async () => {
    const a = sse();
    const c = sse();
    const t = setup([
      a.response,
      new Response(null, { status: 400 }),
      c.response,
    ]);
    t.streams.push(a, c);
    t.live.start();
    await tick();
    a.push("id: 9.4\nevent: hello\ndata: {}\n\n");
    a.push('event: reconnect\ndata: {"reason":"lifetime"}\n\n');
    a.end();
    await tick();
    expect(t.urls).toEqual([
      "/live/stream",
      "/live/stream?cursor=9.4",
      "/live/stream",
    ]);
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.live.current).toBe("live");
    t.live.stop();
  });

  it("a 400 with no cursor to drop stops instead of retrying", async () => {
    const t = setup([new Response(null, { status: 400 })]);
    t.live.start();
    await tick(10 * 60_000);
    expect(t.urls).toHaveLength(1);
    expect(t.live.current).toBe("denied");
  });
});
