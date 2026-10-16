import { beforeEach, describe, expect, it } from "vitest";
import { forward, resolveUpstream } from "@/lib/proxy/forward";

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
    expect(h.get("authorization")).toBe("Bearer client");
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
