import { expect, test } from "@playwright/test";

// The production build served locally, asked for with different Host headers (what Vercel's edge
// forwards for each address). maxRedirects: 0 shows the redirect itself rather than its target.
const ALIASES = [
  "sil-clinic-booking.vercel.app",
  "clinic-web-nine-beta.vercel.app",
  "clinic-web-eric-gitangus-projects.vercel.app",
];

test.describe("the old vercel.app aliases", () => {
  for (const host of ALIASES) {
    test(`${host} 308s to the branded host keeping path and query`, async ({
      request,
    }) => {
      const res = await request.get(
        "/book/abc/details?starts_at=2027-01-12T09%3A00%3A00%2B03%3A00&x=1",
        { headers: { host }, maxRedirects: 0 },
      );
      expect(res.status()).toBe(308);
      expect(res.headers()["location"]).toBe(
        "https://clinic.ericgitangu.com/book/abc/details?starts_at=2027-01-12T09%3A00%3A00%2B03%3A00&x=1",
      );
    });
  }

  test("the root and a static file redirect too", async ({ request }) => {
    for (const [path, to] of [
      ["/", "https://clinic.ericgitangu.com/"],
      ["/robots.txt", "https://clinic.ericgitangu.com/robots.txt"],
    ]) {
      const res = await request.get(path, {
        headers: { host: ALIASES[0] },
        maxRedirects: 0,
      });
      expect(res.status(), path).toBe(308);
      expect(res.headers()["location"], path).toBe(to);
    }
  });

  test("/api, /auth and /.well-known are served on the alias, never bounced", async ({
    request,
  }) => {
    for (const path of [
      "/api/doctors",
      "/auth/get-session",
      "/.well-known/anything",
    ]) {
      const res = await request.get(path, {
        headers: { host: ALIASES[0] },
        maxRedirects: 0,
      });
      expect(res.status(), path).not.toBe(308);
      expect(res.headers()["location"], path).toBeUndefined();
    }
    const api = await request.get("/api/doctors", {
      headers: { host: ALIASES[0] },
    });
    expect(api.status()).toBe(200);
  });

  test("per-deployment, preview and branded hosts and localhost keep serving", async ({
    request,
  }) => {
    for (const host of [
      "clinic-web-4k2j9x8q1-eric-gitangus-projects.vercel.app",
      "clinic-web-git-feat-x-eric-gitangus-projects.vercel.app",
      "clinic.ericgitangu.com",
      "localhost:3100",
    ]) {
      const res = await request.get("/about", {
        headers: { host },
        maxRedirects: 0,
      });
      expect(res.status(), host).toBe(200);
    }
  });
});
