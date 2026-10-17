import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNotConfiguredLog } from "@clinic/api/auth-env";
import { config, proxy } from "@/proxy";

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
    const first = proxy();
    proxy();
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
    const res = proxy();
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

  it.each(["/", "/docs", "/about", "/book", "/robots.txt", "/openapi.json"])(
    "does not guard %s",
    (path) => {
      expect(runs(path)).toBe(false);
    },
  );
});
