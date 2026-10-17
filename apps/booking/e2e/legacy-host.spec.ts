import { expect, test } from "@playwright/test";

// The production build served locally, asked for with different Host headers (what Vercel's edge
// forwards for each address). maxRedirects: 0 shows the redirect itself rather than its target.
const LEGACY = "sil-clinic-booking.vercel.app";

test.describe("the old vercel.app host (ADR-0028)", () => {
  test("308s to the branded host keeping the path and query", async ({
    request,
  }) => {
    const res = await request.get(
      "/book/abc/details?starts_at=2027-01-12T09%3A00%3A00%2B03%3A00&x=1",
      {
        headers: { host: LEGACY },
        maxRedirects: 0,
      },
    );
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toBe(
      "https://clinic.ericgitangu.com/book/abc/details?starts_at=2027-01-12T09%3A00%3A00%2B03%3A00&x=1",
    );
  });

  test("redirects the root and an API path too", async ({ request }) => {
    for (const [path, to] of [
      ["/", "https://clinic.ericgitangu.com"],
      ["/api/doctors", "https://clinic.ericgitangu.com/api/doctors"],
    ]) {
      const res = await request.get(path, {
        headers: { host: LEGACY },
        maxRedirects: 0,
      });
      expect(res.status(), path).toBe(308);
      expect(res.headers()["location"], path).toBe(to);
    }
  });

  test("leaves previews, deployment hosts and localhost alone", async ({
    request,
  }) => {
    for (const host of [
      "sil-clinic-booking-git-feat-x-eric.vercel.app",
      "sil-clinic-booking-4k2j9x8q1-eric.vercel.app",
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
