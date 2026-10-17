import { beforeEach, describe, expect, it } from "vitest";
import {
  buildTarget,
  forward,
  resolveUpstream,
  rewriteLocation,
} from "../src/proxy/forward";

interface Captured {
  url?: string;
  init?: RequestInit;
}

function mockFetch(
  captured: Captured,
  response = new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }),
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.API_URL = "https://api.example.run.app";
  process.env.REALTIME_URL = "https://realtime.example.run.app";
  process.env.API_AUDIENCE = "clinic-api";
  process.env.REALTIME_AUDIENCE = "clinic-realtime";
});

describe("resolveUpstream", () => {
  it("routes /api/stream to the realtime url", () => {
    const u = resolveUpstream(["stream"]);
    expect(u).toEqual({
      kind: "proxy",
      baseUrl: "https://realtime.example.run.app",
      audience: "clinic-realtime",
      upstreamPath: "/stream",
      timeoutMs: 295_000, // the stream may legitimately stay open for minutes
    });
  });

  it("routes everything else to the api url, stripping /api", () => {
    const u = resolveUpstream(["doctors", "abc"]);
    expect(u).toMatchObject({
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/doctors/abc",
    });
  });

  it("redirects the doc paths", () => {
    expect(resolveUpstream(["openapi.json"])).toEqual({
      kind: "redirect",
      to: "/openapi.json",
    });
  });
});

describe("forward", () => {
  it("forwards method, path, query, body and selected headers; sets the token", async () => {
    const cap: Captured = {};
    const req = new Request("https://web.example/api/appointments?x=1", {
      method: "POST",
      headers: {
        "idempotency-key": "k1",
        "x-request-id": "11111111-1111-1111-1111-111111111111",
        authorization: "Bearer client",
        cookie: "session=abc",
        "x-forwarded-for": "6.6.6.6",
        "accept-language": "sw",
        "x-serverless-authorization": "Bearer SPOOF",
        "x-client-ip": "9.9.9.9",
        "content-type": "application/json",
      },
      body: JSON.stringify({ a: 1 }),
    });
    await forward(req, {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/appointments",
      token: "ID_TOKEN",
      clientIp: "1.2.3.4",
      fetchImpl: mockFetch(cap),
    });
    expect(cap.url).toBe("https://api.example.run.app/appointments?x=1");
    expect(cap.init?.method).toBe("POST");
    const h = cap.init!.headers as Headers;
    expect(h.get("idempotency-key")).toBe("k1");
    expect(h.get("x-request-id")).toBe("11111111-1111-1111-1111-111111111111");
    expect(h.get("accept-language")).toBe("sw");
    expect(h.has("authorization")).toBe(false); // allowlist: not forwarded
    expect(h.has("cookie")).toBe(false);
    expect(h.has("x-forwarded-for")).toBe(false);
    expect(h.get("x-serverless-authorization")).toBe("Bearer ID_TOKEN"); // minted, not spoofed
    expect(h.get("x-client-ip")).toBe("1.2.3.4"); // overwritten
    expect(h.has("host")).toBe(false);
  });

  it("returns upstream status and body, dropping content-encoding", async () => {
    const cap: Captured = {};
    const upstream = new Response("hello", {
      status: 201,
      headers: {
        "content-encoding": "gzip",
        "idempotent-replayed": "true",
        location: "x",
      },
    });
    const res = await forward(new Request("https://web.example/api/x"), {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
      fetchImpl: mockFetch(cap, upstream),
    });
    expect(res.status).toBe(201);
    expect(res.headers.has("content-encoding")).toBe(false);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.text()).toBe("hello");
  });

  it("does not mint a token when none is given (local)", async () => {
    const cap: Captured = {};
    await forward(new Request("https://web.example/api/x"), {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
      fetchImpl: mockFetch(cap),
    });
    expect(
      (cap.init!.headers as Headers).has("x-serverless-authorization"),
    ).toBe(false);
  });

  it("413 when the body exceeds 64 KB", async () => {
    const req = new Request("https://web.example/api/x", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 + 1) },
      body: "x",
    });
    const res = await forward(req, {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
    });
    expect(res.status).toBe(413);
  });

  it("405 on an unsupported method", async () => {
    const req = new Request("https://web.example/api/x", { method: "DELETE" });
    const res = await forward(req, {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
    });
    expect(res.status).toBe(405);
  });
});

describe("resolveUpstream rejects unsafe or empty segments", () => {
  const bad: [string, string[]][] = [
    ["empty segment (trailing slash on stream)", ["stream", ""]],
    ["empty segment (trailing slash on docs)", ["docs", ""]],
    ["no segments", []],
    ["dot", ["."]],
    ["dot-dot", ["doctors", ".."]],
    ["slash inside a segment", ["doctors/abc"]],
    ["backslash", ["doctors\\abc"]],
    ["query character", ["doctors?x=1"]],
    ["fragment character", ["doctors#x"]],
    ["control character", ["doctors\u0000"]],
    ["newline", ["doctors\n"]],
  ];
  it.each(bad)("%s -> notfound", (_label, segments) => {
    expect(resolveUpstream(segments)).toEqual({ kind: "notfound" });
  });

  it("accepts ordinary segments", () => {
    expect(resolveUpstream(["doctors", "abc-123"]).kind).toBe("proxy");
  });
});

describe("resolveUpstream never proxies /internal", () => {
  // Next decodes the catch-all once and collapses dot segments before this runs, so these are the
  // shapes the proxy actually sees for /api/internal/x, /api/%69nternal/x, /api/./internal/x and
  // /api/a/../internal/x (the last two become plain ["internal", "x"]).
  const variants: [string, string[]][] = [
    ["plain", ["internal", "admin", "metrics"]],
    [
      "percent-encoded letter, decoded by Next",
      ["internal", "admin", "access"],
    ],
    ["dot segment collapsed by the URL parser", ["internal", "x"]],
    [
      "parent segment collapsed by the URL parser",
      ["internal", "admin", "session"],
    ],
    ["capitalised", ["Internal", "admin", "metrics"]],
    ["upper case", ["INTERNAL", "admin", "metrics"]],
    ["mixed case", ["iNtErNaL", "x"]],
    ["full-width letters", ["ｉｎｔｅｒｎａｌ", "x"]],
    ["bare", ["internal"]],
  ];
  it.each(variants)("%s -> notfound", (_label, segments) => {
    expect(resolveUpstream(segments)).toEqual({ kind: "notfound" });
  });

  it("still rejects the still-encoded and literal-dot spellings", () => {
    expect(resolveUpstream(["%69nternal", "x"])).toEqual({ kind: "notfound" });
    expect(resolveUpstream([".", "internal", "x"])).toEqual({
      kind: "notfound",
    });
    expect(resolveUpstream(["a", "..", "internal"])).toEqual({
      kind: "notfound",
    });
  });

  it("only the first segment is special: a later 'internal' is an ordinary path", () => {
    expect(resolveUpstream(["doctors", "internal"]).kind).toBe("proxy");
    expect(resolveUpstream(["internals"]).kind).toBe("proxy");
  });
});

describe("forward failure handling", () => {
  const base = { baseUrl: "https://api.example.run.app", upstreamPath: "/x" };

  it("502 when the upstream cannot be reached", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await forward(new Request("https://web.example/api/x"), {
      ...base,
      fetchImpl: failing,
    });
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("504 when the upstream times out", async () => {
    const timing = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const res = await forward(new Request("https://web.example/api/x"), {
      ...base,
      fetchImpl: timing,
    });
    expect(res.status).toBe(504);
  });

  it("passes an abort signal so a hung upstream is bounded", async () => {
    const cap: Captured = {};
    await forward(new Request("https://web.example/api/x"), {
      ...base,
      fetchImpl: mockFetch(cap),
    });
    expect(cap.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("413 when a body with no Content-Length exceeds 64 KB", async () => {
    const big = new Uint8Array(64 * 1024 + 1);
    const req = new Request("https://web.example/api/x", {
      method: "POST",
      body: big,
    });
    req.headers.delete("content-length");
    const cap: Captured = {};
    const res = await forward(req, { ...base, fetchImpl: mockFetch(cap) });
    expect(res.status).toBe(413);
    expect(cap.url).toBeUndefined(); // nothing was sent upstream
  });

  it("forwards a small body intact", async () => {
    const cap: Captured = {};
    const req = new Request("https://web.example/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    await forward(req, { ...base, fetchImpl: mockFetch(cap) });
    expect(new TextDecoder().decode(cap.init!.body as Uint8Array)).toBe(
      '{"a":1}',
    );
  });
});

describe("double-encoded traversal", () => {
  // Next decodes the catch-all once, so "%252e%252e" reaches resolveUpstream as "%2e%2e".
  const encoded: [string, string[]][] = [
    ["lowercase %2e%2e", ["x", "%2e%2e", "stream"]],
    ["uppercase %2E%2E", ["x", "%2E%2E", "docs"]],
    ["leading %2e%2e", ["%2e%2e", "health"]],
    ["single %2e", ["x", "%2e", "y"]],
    ["mixed .%2e", ["x", ".%2e", "y"]],
    ["encoded slash %2f", ["x%2fy"]],
    ["encoded backslash %5c", ["x%5cy"]],
    ["encoded NUL %00", ["x%00"]],
    ["encoded question mark %3f", ["x%3fy"]],
    ["a bare percent", ["100%"]],
  ];
  it.each(encoded)("%s -> notfound", (_label, segments) => {
    expect(resolveUpstream(segments)).toEqual({ kind: "notfound" });
  });
});

describe("buildTarget refuses any path the URL parser would rewrite", () => {
  const base = "https://api.example.run.app";
  it.each([
    ["/x/%2e%2e/stream"],
    ["/x/%2E%2E/docs"],
    ["/%2e%2e/health"],
    ["/x/../stream"],
    ["/x/./y"],
  ])("%s -> null", (path) => {
    expect(buildTarget(base, path, "")).toBeNull();
  });

  it("accepts ordinary API paths and keeps the query", () => {
    expect(
      buildTarget(
        base,
        "/doctors/abc/availability",
        "?date=2026-10-26",
      )?.toString(),
    ).toBe(
      "https://api.example.run.app/doctors/abc/availability?date=2026-10-26",
    );
  });

  it("forward() answers 404 and sends nothing upstream for a crafted path", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("x");
    }) as unknown as typeof fetch;
    const res = await forward(new Request("https://web.example/api/x"), {
      baseUrl: base,
      upstreamPath: "/x/%2e%2e/stream",
      fetchImpl: spy,
    });
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });
});

describe("response headers are allowlisted", () => {
  it("drops platform and cookie headers, keeps the documented ones", async () => {
    const upstream = new Response("ok", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "2",
        "x-request-id": "rid",
        "server-timing": "app;dur=1",
        "idempotent-replayed": "true",
        "set-cookie": "a=b",
        server: "Google Frontend",
        "x-cloud-trace-context": "abc/1",
        "www-authenticate": "Bearer",
        "access-control-allow-origin": "https://run.app",
      },
    });
    const res = await forward(new Request("https://web.example/api/x"), {
      baseUrl: "https://api.example.run.app",
      upstreamPath: "/x",
      fetchImpl: (async () => upstream) as unknown as typeof fetch,
    });
    for (const kept of [
      "content-type",
      "cache-control",
      "retry-after",
      "x-request-id",
      "server-timing",
      "idempotent-replayed",
    ]) {
      expect(res.headers.has(kept), kept).toBe(true);
    }
    for (const dropped of [
      "set-cookie",
      "server",
      "x-cloud-trace-context",
      "www-authenticate",
      "access-control-allow-origin",
    ]) {
      expect(res.headers.has(dropped), dropped).toBe(false);
    }
  });
});

describe("rewriteLocation", () => {
  const base = "https://api.example.run.app";
  it.each([
    ["/appointments/x", "/api/appointments/x"],
    ["https://api.example.run.app/appointments/x", "/api/appointments/x"],
    [
      "https://api.example.run.app/appointments/x?a=1#f",
      "/api/appointments/x?a=1#f",
    ],
    ["https://elsewhere.example/x", "https://elsewhere.example/x"],
  ])("%s -> %s", (input, expected) => {
    expect(rewriteLocation(input, base)).toBe(expected);
  });

  it("an absolute Location on the run.app origin never reaches the browser", async () => {
    const res = await forward(
      new Request("https://web.example/api/appointments", { method: "POST" }),
      {
        baseUrl: base,
        upstreamPath: "/appointments",
        fetchImpl: (async () =>
          new Response(null, {
            status: 201,
            headers: { location: `${base}/appointments/abc` },
          })) as unknown as typeof fetch,
      },
    );
    expect(res.headers.get("location")).toBe("/api/appointments/abc");
  });
});
