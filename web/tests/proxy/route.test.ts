import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/proxy/gcp-id-token", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/lib/proxy/gcp-id-token")>();
  return { ...real, mintIdToken: vi.fn(), minting_enabled: vi.fn(() => false) };
});

import { GET } from "@/app/api/[...path]/route";
import {
  TokenMintError,
  mintIdToken,
  minting_enabled,
} from "@/lib/proxy/gcp-id-token";
import { _clearRateLimitForTests } from "@/lib/proxy/rate-limit";

function call(path: string[], headers: Record<string, string> = {}) {
  const req = new Request(`https://web.example/api/${path.join("/")}`, {
    headers,
  });
  return GET(req, { params: Promise.resolve({ path }) });
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
