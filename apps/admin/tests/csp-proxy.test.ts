import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";

// Vitest runs with NODE_ENV=test, which the options read as development; these tests are about the
// production policy.
vi.mock("@/lib/csp-options", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/csp-options")>();
  return { ...real, CSP_OPTIONS: { ...real.CSP_OPTIONS, dev: false } };
});

const req = (path: string) =>
  new NextRequest(`https://admin.example.test${path}`);

describe("proxy with sign-in configured", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://admin.example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "s");
    vi.stubEnv("GOOGLE_CLIENT_ID", "i");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "c");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["/", "/dashboard", "/access", "/dashboard/appointments/x"])(
    "gives %s its own nonce, passed on to the page",
    (path) => {
      const a = proxy(req(path));
      const b = proxy(req(path));
      const csp = a.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      // Next reads the nonce from the request's own policy header; the page reads x-nonce.
      expect(
        a.headers.get("x-middleware-request-content-security-policy"),
      ).toBe(csp);
      expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
      expect(b.headers.get("content-security-policy")).not.toBe(csp);
    },
  );

  it.each([
    "/auth/get-session",
    "/live/stream",
    "/robots.txt",
    "/_next/static/x.js",
  ])("leaves %s alone: no nonce (the 404 page and non-pages)", (path) => {
    expect(proxy(req(path)).headers.get("content-security-policy")).toBeNull();
  });
});
