import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  appointmentFilter,
  buildUpstream,
  mapUpstreamStatus,
  openUpstream,
  resumeCursor,
} from "@/lib/live-upstream";

const KEY = "k".repeat(40);
const NOW = new Date("2026-10-19T04:00:00Z");

function claims(header: string) {
  const [v, payload, mac] = header.split(".");
  expect(v).toBe("v1");
  expect(createHmac("sha256", KEY).update(payload).digest("base64url")).toBe(
    mac,
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("resumeCursor", () => {
  it("takes the query parameter, then Last-Event-ID, and only well-formed values", () => {
    expect(resumeCursor("12.34", "1.1")).toBe("12.34");
    expect(resumeCursor(null, "1.1")).toBe("1.1");
    expect(resumeCursor("nope", "5.6")).toBe("5.6");
    expect(resumeCursor("01.2", null)).toBeNull();
    expect(resumeCursor("1.2; DROP", null)).toBeNull();
    expect(resumeCursor(null, null)).toBeNull();
    expect(resumeCursor("1".repeat(21) + ".1", null)).toBeNull();
  });
});

describe("buildUpstream", () => {
  const who = { sub: "g-1", email: "owner@clinic.example", role: "owner" };

  it("signs the assertion for exactly the target it requests", () => {
    const r = buildUpstream({
      base: "https://rt.example/",
      who,
      cursor: "12.34",
      signingKey: KEY,
      now: NOW,
      idToken: null,
    });
    expect(r.url).toBe("https://rt.example/stream?cursor=12.34");
    const c = claims(r.headers["X-Internal-Assertion"]);
    expect(c).toMatchObject({
      aud: "clinic-api/internal",
      sub: "g-1",
      email: "owner@clinic.example",
      role: "owner",
      m: "GET",
      p: "/stream?cursor=12.34",
      bh: createHash("sha256").update("").digest("hex"),
      ev: true,
    });
    expect(c.exp - c.iat).toBe(60);
  });

  it("asks for a fresh stream without a cursor, and adds the IAM token only when there is one", () => {
    const plain = buildUpstream({
      base: "http://127.0.0.1:8090",
      who,
      cursor: null,
      signingKey: KEY,
      now: NOW,
      idToken: null,
    });
    expect(plain.url).toBe("http://127.0.0.1:8090/stream");
    expect(claims(plain.headers["X-Internal-Assertion"]).p).toBe("/stream");
    expect(plain.headers["x-serverless-authorization"]).toBeUndefined();
    const iam = buildUpstream({
      base: "https://rt.example",
      who,
      cursor: null,
      signingKey: KEY,
      now: NOW,
      idToken: "tok",
    });
    expect(iam.headers["x-serverless-authorization"]).toBe("Bearer tok");
  });
});

describe("appointment filter", () => {
  const who = { sub: "g-1", email: "owner@clinic.example", role: "owner" };
  const id = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

  it("accepts one canonical lower-case UUID and nothing else", () => {
    expect(appointmentFilter(null)).toBeNull();
    expect(appointmentFilter(id)).toBe(id);
    for (const bad of [
      "",
      id.toUpperCase(),
      `${id}0`,
      "x",
      `${id}&cursor=1.1`,
    ]) {
      expect(appointmentFilter(bad)).toBe("invalid");
    }
  });

  it("is part of the signed target, before the cursor", () => {
    const r = buildUpstream({
      base: "https://rt.example",
      who,
      cursor: "12.34",
      appointment: id,
      signingKey: KEY,
      now: NOW,
      idToken: null,
    });
    expect(r.url).toBe(
      `https://rt.example/stream?appointment=${id}&cursor=12.34`,
    );
    expect(claims(r.headers["X-Internal-Assertion"]).p).toBe(
      `/stream?appointment=${id}&cursor=12.34`,
    );
  });
});

describe("passing the gateway's answer on", () => {
  const req = { url: "https://rt.example/stream", headers: {} };

  it("maps 429 to the busy fallback, 422 to 400 (drop the cursor), the rest to a refusal or unavailable", () => {
    expect(mapUpstreamStatus(429, "45")).toEqual({
      status: 429,
      code: "RATE_LIMITED",
      retryAfter: "45",
    });
    expect(mapUpstreamStatus(422, null)).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
      retryAfter: "0",
    });
    expect(mapUpstreamStatus(403, null).code).toBe("FORBIDDEN");
    expect(mapUpstreamStatus(401, null).status).toBe(401);
    expect(mapUpstreamStatus(503, null).code).toBe("REALTIME_UNAVAILABLE");
    expect(mapUpstreamStatus(500, null)).toMatchObject({ status: 503 });
  });

  it("a Cloud Run queue that sends no headers within the limit is busy, not a hang", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_ok, fail) => {
            seen = init?.signal ?? undefined;
            seen?.addEventListener("abort", () =>
              fail(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const pending = openUpstream({
        req,
        signal: new AbortController().signal,
        lifetimeMs: 295_000,
        headerTimeoutMs: 10_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        kind: "problem",
        problem: { status: 429, code: "RATE_LIMITED", retryAfter: "30" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cloud Run's own 429 and the gateway's 422 reach the page as busy and as 400", async () => {
    for (const [status, want] of [
      [429, 429],
      [422, 400],
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response("x", { status }));
      const r = await openUpstream({
        req,
        signal: new AbortController().signal,
        lifetimeMs: 295_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(r.kind === "problem" && r.problem.status).toBe(want);
    }
  });

  it("a stream that answers in time is passed through, and a client that left is not an error", async () => {
    const body = new ReadableStream<Uint8Array>();
    const ok = await openUpstream({
      req,
      signal: new AbortController().signal,
      lifetimeMs: 295_000,
      fetchImpl: (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch,
    });
    expect(ok.kind).toBe("stream");
    const gone = new AbortController();
    gone.abort();
    const r = await openUpstream({
      req,
      signal: gone.signal,
      lifetimeMs: 295_000,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(r.kind).toBe("aborted");
  });
});
