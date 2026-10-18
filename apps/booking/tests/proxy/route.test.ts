import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clinic/api/proxy/gcp-id-token", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@clinic/api/proxy/gcp-id-token")>();
  return { ...real, mintIdToken: vi.fn(), minting_enabled: vi.fn(() => false) };
});

import { GET, POST } from "@/app/api/[...path]/route";
import {
  TokenMintError,
  mintIdToken,
  minting_enabled,
} from "@clinic/api/proxy/gcp-id-token";
import { _clearRateLimitForTests } from "@clinic/api/proxy/rate-limit";

function call(path: string[], headers: Record<string, string> = {}) {
  const req = new Request(`https://web.example/api/${path.join("/")}`, {
    headers,
  });
  return GET(req, { params: Promise.resolve({ path }) });
}

function post(
  path: string[],
  headers: Record<string, string> = {},
  body = "{}",
) {
  const req = new Request(`https://web.example/api/${path.join("/")}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return POST(req, { params: Promise.resolve({ path }) });
}

// What the stand-in for Cloud Run received: the upstream request's headers.
function upstreamHeaders(spy: ReturnType<typeof vi.spyOn>): Headers {
  const init = spy.mock.calls.at(-1)?.[1] as RequestInit;
  return init.headers as Headers;
}

beforeEach(() => {
  _clearRateLimitForTests();
  process.env.API_URL = "https://api.example.run.app";
  process.env.REALTIME_URL = "https://realtime.example.run.app";
  vi.mocked(minting_enabled).mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("the real route handler", () => {
  it("refuses a double-encoded dot segment and sends nothing upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const segments of [
      ["x", "%2e%2e", "stream"],
      ["x", "%2E%2E", "docs"],
      ["%2e%2e", "health"],
    ]) {
      const res = await call(segments);
      expect(res.status, segments.join("/")).toBe(404);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 for /internal in every spelling and sends nothing upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const segments of [
      ["internal", "admin", "metrics"],
      ["Internal", "admin", "metrics"],
      ["INTERNAL", "admin", "access"],
      ["internal"],
    ]) {
      const res = await call(segments);
      expect(res.status, segments.join("/")).toBe(404);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a normal request to the API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await call(["doctors"], {
      "x-vercel-forwarded-for": "203.0.113.5",
    });
    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      "https://api.example.run.app/doctors",
    );
  });

  it("a token mint failure is a 502 and is logged with its stage and status, never a token", async () => {
    vi.mocked(minting_enabled).mockReturnValue(true);
    vi.mocked(mintIdToken).mockRejectedValue(
      new TokenMintError("sts", 403, "invalid_grant"),
    );
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await call(["doctors"], {
      "x-vercel-forwarded-for": "203.0.113.6",
    });

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("UPSTREAM_AUTH_FAILED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    const entry = JSON.parse(logged[0]);
    expect(entry).toMatchObject({
      severity: "ERROR",
      stage: "sts",
      status: 403,
      detail: "invalid_grant",
    });
    expect(logged[0]).not.toMatch(/eyJ|Bearer|token":/);
  });

  it("a request with no client address is limited as one untrusted client", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("ok"),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await call(["doctors"])).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("the live-updates token route and the client address", () => {
  const TOKEN = ["realtime", "token", "patient"];
  const SITE = "https://web.example";
  const stub = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 200 }));

  afterEach(() => {
    delete process.env.VERCEL;
  });

  it("refuses a cross-site Origin with a 403 and sends nothing upstream", async () => {
    const spy = stub();
    for (const origin of [
      "https://evil.example",
      "http://web.example", // same host, other scheme
      "https://web.example.evil.example",
      "null",
    ]) {
      const res = await post(TOKEN, {
        origin,
        "x-vercel-forwarded-for": "203.0.113.5",
      });
      expect(res.status, origin).toBe(403);
      expect((await res.json()).code).toBe("FORBIDDEN");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes this site's own Origin on to the API, for this route only", async () => {
    const spy = stub();
    const ok = await post(TOKEN, {
      origin: SITE,
      "x-vercel-forwarded-for": "203.0.113.5",
    });
    expect(ok.status).toBe(200);
    expect(upstreamHeaders(spy).get("origin")).toBe(SITE);

    await post(["appointments"], {
      origin: SITE,
      "x-vercel-forwarded-for": "203.0.113.5",
    });
    expect(upstreamHeaders(spy).has("origin")).toBe(false);
  });

  it("lets a request with no Origin through (not a browser) without inventing one", async () => {
    const spy = stub();
    const res = await post(TOKEN, { "x-vercel-forwarded-for": "203.0.113.5" });
    expect(res.status).toBe(200);
    expect(upstreamHeaders(spy).has("origin")).toBe(false);
  });

  it("only checks Origin on that route and that method", async () => {
    const spy = stub();
    const other = await post(["appointments"], {
      origin: "https://evil.example",
      "x-vercel-forwarded-for": "203.0.113.5",
    });
    expect(other.status).toBe(200); // other routes keep their CORS-free behaviour
    expect(spy).toHaveBeenCalled();
  });

  it("always sets x-client-ip from the edge's address, and drops one the client sent", async () => {
    const spy = stub();
    await call(["doctors"], {
      "x-vercel-forwarded-for": "203.0.113.5",
      "x-client-ip": "9.9.9.9",
    });
    expect(upstreamHeaders(spy).get("x-client-ip")).toBe("203.0.113.5");

    // The right-most entry is the one the nearest trusted proxy appended.
    await call(["doctors"], {
      "x-vercel-forwarded-for": "6.6.6.6, 203.0.113.7",
      "x-client-ip": "9.9.9.9",
    });
    expect(upstreamHeaders(spy).get("x-client-ip")).toBe("203.0.113.7");

    await call(["doctors"], {
      "x-forwarded-for": "198.51.100.4",
      "x-client-ip": "9.9.9.9",
    });
    expect(upstreamHeaders(spy).get("x-client-ip")).toBe("198.51.100.4");
  });

  it("on Vercel with no address the API gets none (it answers 400), never the client's own header", async () => {
    process.env.VERCEL = "1";
    const spy = stub();
    await call(["doctors"], { "x-client-ip": "9.9.9.9" });
    expect(upstreamHeaders(spy).has("x-client-ip")).toBe(false);
  });

  it("off Vercel (development, end-to-end runs) the client is this machine", async () => {
    delete process.env.VERCEL;
    const spy = stub();
    await call(["doctors"], { "x-client-ip": "9.9.9.9" });
    expect(upstreamHeaders(spy).get("x-client-ip")).toBe("127.0.0.1");
  });
});
