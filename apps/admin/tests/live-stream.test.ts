import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_REFRESH_MS,
  BUSY_RETRY_BASE_MS,
  BUSY_RETRY_MAX_MS,
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
  over: {
    hidden?: () => boolean;
    cursor?: string;
    random?: () => number;
  } = {},
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
  const hellos: string[] = [];
  const statuses: LiveStatus[] = [];
  const refresh = vi.fn();
  const live = new LiveStream({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    onEvent: (id, event, _data, replay) =>
      events.push(`${id}:${event}${replay ? ":replay" : ""}`),
    onHello: (id, data) => hellos.push(`${id}:${data}`),
    onStatus: (s) => statuses.push(s),
    onRefresh: refresh,
    isHidden: over.hidden,
    cursor: over.cursor,
    // No jitter unless a test asks for it: the midpoint of 0.8..1.2 is exactly 1.
    random: over.random ?? (() => 0.5),
  });
  return { live, urls, events, hellos, statuses, refresh, streams };
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

  it("retries a busy gateway with a growing delay: 30 s, 60 s, 120 s, 240 s, then 240 s", async () => {
    const busy = () =>
      new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    const t = setup([busy(), busy(), busy(), busy(), busy(), busy()]);
    t.live.start();
    await tick();
    let at = 0;
    for (const wait of [30_000, 60_000, 120_000, 240_000, 240_000]) {
      await tick(wait - 1);
      expect(t.live.attempts).toBe(1 + at);
      await tick(1);
      at += 1;
      expect(t.live.attempts).toBe(1 + at);
    }
    expect(BUSY_RETRY_BASE_MS).toBe(30_000);
    expect(BUSY_RETRY_MAX_MS).toBe(240_000);
    // ...refreshing every 30 s throughout: 690 s of busy is 23 refreshes.
    expect(t.refresh).toHaveBeenCalledTimes(23);
    expect(t.live.current).toBe("busy");
    t.live.stop();
  });

  it("jitters the busy retry by up to 20 %, and never goes below Retry-After", async () => {
    const busy = (after: string) =>
      new Response("{}", { status: 429, headers: { "retry-after": after } });
    const low = setup([busy("1"), "network"], { random: () => 0 });
    low.live.start();
    await tick();
    await tick(24_000 - 1);
    expect(low.live.attempts).toBe(1);
    await tick(1);
    expect(low.live.attempts).toBe(2);
    low.live.stop();

    const told = setup([busy("100"), "network"], { random: () => 0 });
    told.live.start();
    await tick();
    await tick(100_000 - 1);
    expect(told.live.attempts).toBe(1);
    await tick(1);
    expect(told.live.attempts).toBe(2);
    told.live.stop();
  });

  it("the streak resets once live: the next refusal waits 30 s again", async () => {
    const busy = () => new Response("{}", { status: 429 });
    const a = sse();
    const t = setup([busy(), busy(), a.response, busy(), "network"]);
    t.streams.push(a);
    t.live.start();
    await tick();
    await tick(30_000);
    await tick(60_000);
    expect(t.live.current).toBe("live");
    a.push('event: reconnect\ndata: {"reason":"lifetime"}\n\n');
    a.end();
    await tick();
    expect(t.live.current).toBe("busy");
    expect(t.live.attempts).toBe(4);
    await tick(30_000);
    expect(t.live.attempts).toBe(5);
    t.live.stop();
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

  it("starts from a given cursor (a new leader tab), reports hello, and never asks for an appointment filter", async () => {
    const a = sse();
    const t = setup([a.response], { cursor: "7.3" });
    t.streams.push(a);
    t.live.start();
    await tick();
    a.push('id: 7.3\nevent: hello\ndata: {"role":"owner"}\n\n');
    a.push("id: 7.4\nevent: booked\ndata: {}\n\n");
    await tick();
    expect(t.urls).toEqual(["/live/stream?cursor=7.3"]);
    expect(t.hellos).toEqual(['7.3:{"role":"owner"}']);
    expect(t.events).toEqual(["7.4:booked"]);
    expect(t.live.cursor).toBe("7.4");
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

describe("LiveStream: replay after a resume", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hello = (id: string, horizon: string) =>
    `id: ${id}\nevent: hello\ndata: ${JSON.stringify({ cursor: id, horizon })}\n\n`;

  it("marks the rows below the horizon as replay and the ones at or above it as live, whatever the timing", async () => {
    const a = sse();
    const t = setup([a.response], { cursor: "5.0" });
    t.streams.push(a);
    t.live.start();
    await tick();
    a.push(hello("5.0", "9.0"));
    a.push('id: 5.1\nevent: booked\ndata: {"x":1}\n\n');
    a.push('id: 8.7\nevent: arrived\ndata: {"x":2}\n\n');
    // A real event right after the replay, with no gap at all: live, because its txid is not
    // below the horizon.
    a.push('id: 9.1\nevent: arrived\ndata: {"x":3}\n\n');
    await tick();
    a.push('id: 12.1\nevent: booked\ndata: {"x":4}\n\n');
    await tick(3000);
    expect(t.events).toEqual([
      "5.1:booked:replay",
      "8.7:arrived:replay",
      "9.1:arrived",
      "12.1:booked",
    ]);
  });

  it("a fresh connection starts at the horizon, so nothing it sends is replay", async () => {
    const a = sse();
    const t = setup([a.response]);
    t.streams.push(a);
    t.live.start();
    await tick();
    a.push(hello("9.0", "9.0"));
    a.push('id: 9.1\nevent: booked\ndata: {"x":1}\n\n');
    await tick();
    expect(t.events).toEqual(["9.1:booked"]);
  });

  it("marks nothing as replay when the gateway sent no horizon", async () => {
    const a = sse();
    const t = setup([a.response], { cursor: "5.0" });
    t.streams.push(a);
    t.live.start();
    await tick();
    a.push("id: 5.0\nevent: hello\ndata: {}\n\n");
    a.push('id: 5.1\nevent: booked\ndata: {"x":1}\n\n');
    await tick();
    expect(t.events).toEqual(["5.1:booked"]);
  });

  it("ignores a malformed horizon", async () => {
    const a = sse();
    const t = setup([a.response], { cursor: "5.0" });
    t.streams.push(a);
    t.live.start();
    await tick();
    a.push(hello("5.0", "not-a-seq"));
    a.push('id: 5.1\nevent: booked\ndata: {"x":1}\n\n');
    await tick();
    expect(t.events).toEqual(["5.1:booked"]);
  });
});
