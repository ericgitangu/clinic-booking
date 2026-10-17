import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetNotConfiguredLog } from "@clinic/api/auth-env";
import {
  REDIRECTED_HOSTS,
  canonicalRedirect,
  isExcluded,
} from "@/lib/canonical-host";
import { config, proxy } from "@/proxy";

const CANONICAL = "https://clinic-admin.ericgitangu.com";
const ALIASES = [
  "clinic-admin-azure.vercel.app",
  "clinic-admin-eric-gitangus-projects.vercel.app",
] as const;

// Every host CI or the release steps reach the admin app on, read from scripts/ci/vercel_prod.sh,
// scripts/ci/public_smoke.sh and scripts/ci/public-urls.env: the custom domain (ADMIN), and the
// per-deployment URL that `vercel deploy --prebuilt --prod` prints and `vercel_prod.sh id-of`
// resolves (<project>-<hash>-<team>.vercel.app), plus a preview. None of them may be redirected.
const CI_HOSTS = [
  "clinic-admin.ericgitangu.com",
  "clinic-admin-k3j9x2abc-eric-gitangus-projects.vercel.app",
  "clinic-admin-git-feat-x-eric-gitangus-projects.vercel.app",
  "localhost:3101",
  "localhost",
  "127.0.0.1:3101",
] as const;

const req = (host: string, path: string) =>
  new NextRequest(`https://${host}${path}`, { headers: { host } });

const GOOD_ENV = {
  BETTER_AUTH_URL: "https://x.example.test",
  BETTER_AUTH_SECRET: "s",
  GOOGLE_CLIENT_ID: "i",
  GOOGLE_CLIENT_SECRET: "c",
};

describe("the vercel.app aliases redirect to the custom domain", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(GOOD_ENV)) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(ALIASES)("%s answers 308, keeping path and query", (host) => {
    const res = proxy(
      req(host, "/dashboard/appointments/abc?days=30&status=booked"),
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      `${CANONICAL}/dashboard/appointments/abc?days=30&status=booked`,
    );
  });

  it.each(ALIASES)("%s root goes to the canonical root", (host) => {
    const res = proxy(req(host, "/"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${CANONICAL}/`);
  });

  it("matches the host without regard to case or port", () => {
    expect(
      canonicalRedirect("Clinic-Admin-Azure.vercel.app:443", "/x", ""),
    ).toBe(`${CANONICAL}/x`);
  });

  it("redirects an alias even when sign-in is not configured", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(proxy(req(ALIASES[0], "/dashboard")).status).toBe(308);
  });

  it.each(CI_HOSTS)("%s keeps serving (no redirect)", (host) => {
    for (const path of ["/", "/dashboard", "/robots.txt", "/dashboard?x=1"]) {
      const res = proxy(req(host, path));
      expect(res.status, `${host}${path}`).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("does not treat any other vercel.app name as an alias", () => {
    for (const host of [
      "clinic-admin.vercel.app",
      "evil-clinic-admin-azure.vercel.app",
      "clinic-admin-azure.vercel.app.evil.test",
      "sil-clinic-booking.vercel.app",
    ]) {
      expect(canonicalRedirect(host, "/dashboard", ""), host).toBeNull();
    }
  });

  it.each([
    "/api",
    "/api/anything",
    "/auth/callback/google",
    "/auth/sign-in/social",
    "/.well-known/security.txt",
  ])("%s on an alias is not redirected", (path) => {
    for (const host of ALIASES) {
      const res = proxy(req(host, path));
      expect(res.status, `${host}${path}`).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("excludes whole segments only: /apiary and /authors are redirected", () => {
    expect(isExcluded("/apiary")).toBe(false);
    expect(isExcluded("/authors")).toBe(false);
    expect(canonicalRedirect(ALIASES[0], "/apiary", "")).toBe(
      `${CANONICAL}/apiary`,
    );
  });

  it("keeps the allowlist exactly the two stable aliases", () => {
    expect([...REDIRECTED_HOSTS].sort()).toEqual([...ALIASES].sort());
  });
});

describe("the 503 logic still runs for everyone else", () => {
  beforeEach(() => {
    resetNotConfiguredLog();
    for (const k of Object.keys(GOOD_ENV)) vi.stubEnv(k, "");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers 503 on the canonical host, on a deployment URL and on an alias's /auth", () => {
    for (const [host, path] of [
      ["clinic-admin.ericgitangu.com", "/dashboard"],
      [
        "clinic-admin-k3j9x2abc-eric-gitangus-projects.vercel.app",
        "/dashboard",
      ],
      [ALIASES[0], "/auth/callback/google"],
    ] as const) {
      expect(proxy(req(host, path)).status, `${host}${path}`).toBe(503);
    }
  });
});

describe("the matcher puts the proxy in front of what the redirect needs", () => {
  const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it.each([
    "/",
    "/dashboard",
    "/dashboard/appointments/x?days=7",
    "/auth/x",
    "/api/x",
  ])("runs for %s", (p) => expect(runs(p)).toBe(true));
});
