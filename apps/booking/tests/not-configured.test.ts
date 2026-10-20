import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNotConfiguredLog } from "@clinic/api/auth-env";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

// Vitest runs with NODE_ENV=test, which the options read as development; these tests are about the
// production policy.
vi.mock("@/lib/csp-options", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/csp-options")>();
  return { ...real, CSP_OPTIONS: { ...real.CSP_OPTIONS, dev: false } };
});

const req = (url = "https://clinic.ericgitangu.com/appointments") =>
  new NextRequest(url);

const NAMES = [
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
];

describe("proxy when sign-in is not configured", () => {
  beforeEach(() => {
    resetNotConfiguredLog();
    for (const n of NAMES) vi.stubEnv(n, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers 503 with the not-configured page and logs once, names only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = proxy(req());
    proxy(req());
    expect(first.status).toBe(503);
    expect(await first.text()).toContain("Sign-in is not configured");
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]![0]));
    expect(line).toMatchObject({
      event: "auth_not_configured",
      app: "booking",
    });
    expect(line.missing).toEqual(NAMES);
    spy.mockRestore();
  });

  it("lets the request through once the settings are there", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://x.example.test");
    vi.stubEnv("BETTER_AUTH_SECRET", "s");
    vi.stubEnv("GOOGLE_CLIENT_ID", "i");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "c");
    const res = proxy(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  // Next's own matcher semantics decide whether proxy() runs for a URL, so this fails if a route
  // that needs sign-in drops out of config.matcher or a public one is pulled in.
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it.each([
    "/appointments/x",
    "/auth/get-session",
    "/book/abc/details",
    "/book/confirmed/x",
  ])("guards %s", (path) => {
    expect(runs(path)).toBe(true);
  });

  // The pages rendered per request run the proxy for their nonce, but need no sign-in settings.
  it.each(["/", "/book", "/book/abc"])(
    "gives %s a nonce without needing sign-in",
    (path) => {
      expect(runs(path)).toBe(true);
      const res = proxy(req(`https://clinic.ericgitangu.com${path}`));
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toMatch(
        /script-src 'nonce-[^']+' 'sha256-[^']+' 'strict-dynamic'/,
      );
      expect(csp).not.toContain("unsafe-inline'; style"); // scripts never allow inline
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    },
  );

  // Pages built once cannot carry a nonce; next.config.ts gives them their own policy.
  it.each([
    "/docs",
    "/redoc",
    "/about",
    "/data",
    "/privacy",
    "/terms",
    "/robots.txt",
    "/openapi.json",
  ])("does not run the proxy for %s", (path) => {
    expect(runs(path)).toBe(false);
  });
});
