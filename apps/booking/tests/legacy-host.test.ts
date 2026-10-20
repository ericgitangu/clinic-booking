import { readFileSync } from "node:fs";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEGACY_HOSTS, legacyRedirect } from "@/lib/legacy-host";
import { config, proxy } from "@/proxy";

const CANONICAL = "clinic.ericgitangu.com";
const HASH_DEPLOYMENT =
  "clinic-web-4k2j9x8q1-eric-gitangus-projects.vercel.app";
const PREVIEW = "clinic-web-git-feat-x-eric-gitangus-projects.vercel.app";

// Next's own matcher semantics decide whether proxy() runs for a request.
const runs = (host: string, path: string) =>
  unstable_doesMiddlewareMatch({
    config,
    url: `https://${host}${path}`,
    headers: { host },
  });

const call = (host: string, path: string) =>
  proxy(new NextRequest(`https://${host}${path}`, { headers: { host } }));

// The hosts CI and the release scripts reach, read from the committed file.
function ciHosts(): string[] {
  const env = readFileSync(
    new URL("../../../scripts/ci/public-urls.env", import.meta.url),
    "utf8",
  );
  return [...env.matchAll(/^[A-Z_]+=(https?:\/\/[^\s#]+)/gm)].map(
    (m) => new URL(m[1]).host,
  );
}

describe("legacy alias list", () => {
  it("is the list the matcher in proxy.ts names", () => {
    const entry = config.matcher.find((m) => typeof m !== "string");
    const value = (entry as { has: { value: string }[] }).has[0].value;
    const fromMatcher = value
      .slice(1, -1)
      .split("|")
      .map((h) => h.replaceAll("\\.", "."));
    expect(fromMatcher.sort()).toEqual([...LEGACY_HOSTS].sort());
  });
});

describe("the real proxy() on a legacy alias", () => {
  beforeEach(() => {
    // Sign-in settings absent: the redirect must still happen, and must come first. The
    // not-configured guard logs once; keep that line out of the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const n of [
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ])
      vi.stubEnv(n, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(LEGACY_HOSTS)(
    "%s: 308 to the branded host, path and query kept",
    (host) => {
      expect(runs(host, "/book/abc?date=2027-01-12")).toBe(true);
      const res = call(host, "/book/abc?date=2027-01-12&x=a%20b");
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(
        `https://${CANONICAL}/book/abc?date=2027-01-12&x=a%20b`,
      );
    },
  );

  it("redirects the root to the branded root, and sign-in routes too", () => {
    const [host] = LEGACY_HOSTS;
    expect(call(host, "/").headers.get("location")).toBe(
      `https://${CANONICAL}/`,
    );
    expect(call(host, "/appointments/x").status).toBe(308);
  });

  it("matches the host regardless of case or port", () => {
    expect(legacyRedirect("SIL-clinic-booking.vercel.app:443", "/", "")).toBe(
      `https://${CANONICAL}/`,
    );
  });

  it.each([
    "/api/health",
    "/api",
    "/auth/callback/google",
    "/.well-known/jwks",
  ])("never redirects %s", (path) => {
    for (const host of LEGACY_HOSTS) {
      expect(legacyRedirect(host, path, "?a=1")).toBeNull();
    }
    // Under /auth the sign-in guard still applies (503 here, as there are no settings), not a bounce.
    const res = call(LEGACY_HOSTS[0], path);
    expect(res.status).not.toBe(308);
  });

  it("keeps /api and /.well-known out of the proxy on an alias", () => {
    for (const host of LEGACY_HOSTS)
      for (const path of ["/api/health", "/.well-known/jwks"])
        expect(runs(host, path), `${host}${path}`).toBe(false);
  });

  it("does not treat a lookalike prefix as excluded", () => {
    expect(legacyRedirect(LEGACY_HOSTS[0], "/apiary", "")).not.toBeNull();
    expect(legacyRedirect(LEGACY_HOSTS[0], "/authors", "")).not.toBeNull();
  });
});

describe("everything else keeps serving", () => {
  const others = [
    CANONICAL,
    "clinic-admin.ericgitangu.com",
    HASH_DEPLOYMENT,
    PREVIEW,
    "xsil-clinic-booking.vercel.app",
    "sil-clinic-booking.vercel.app.evil.example",
    "silXclinic-booking.vercel.app",
    "localhost",
    "127.0.0.1",
    ...ciHosts(),
  ];

  it("includes the hosts CI reaches (public-urls.env), none of them an alias", () => {
    expect(ciHosts().length).toBeGreaterThanOrEqual(3);
    for (const h of ciHosts())
      expect((LEGACY_HOSTS as readonly string[]).includes(h)).toBe(false);
  });

  it.each(others)(
    "%s is not redirected and pages built once skip the proxy",
    (host) => {
      expect(legacyRedirect(host, "/book", "?a=1")).toBeNull();
      // "/" and "/book" run it too now, for their nonce, but never redirect (checked above).
      for (const path of ["/docs", "/about", "/privacy", "/openapi.json"])
        expect(runs(host, path), `${host}${path}`).toBe(false);
    },
  );

  it("still guards the sign-in routes on every host", () => {
    for (const host of [CANONICAL, HASH_DEPLOYMENT, "localhost"])
      for (const path of [
        "/appointments/x",
        "/auth/get-session",
        "/book/a/details",
      ])
        expect(runs(host, path)).toBe(true);
  });
});
