import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { LEGACY_HOST, legacyHostRedirect } from "@/lib/legacy-host";
import { SITE } from "@/lib/site";

// Next evaluates a `has` host value as a regular expression over the whole host.
const hostMatches = (host: string) =>
  new RegExp(`^${legacyHostRedirect.has[0].value}$`).test(host);

describe("legacy vercel.app host redirect (ADR-0028)", () => {
  it("matches the production alias and nothing else", () => {
    expect(hostMatches(LEGACY_HOST)).toBe(true);
    for (const other of [
      "sil-clinic-booking-git-feat-x-eric.vercel.app", // branch preview
      "sil-clinic-booking-4k2j9x8q1-eric.vercel.app", // deployment hash host
      "xsil-clinic-booking.vercel.app",
      "sil-clinic-booking.vercel.app.evil.example",
      "silXclinic-booking.vercel.app", // the dots are literal, not wildcards
      "localhost",
      "127.0.0.1",
      "clinic.ericgitangu.com",
    ]) {
      expect(hostMatches(other), other).toBe(false);
    }
  });

  it("sends path and query to the branded host as a permanent redirect", () => {
    expect(legacyHostRedirect).toMatchObject({
      source: "/:path*",
      destination: `${SITE.url}/:path*`,
      permanent: true, // 308
    });
    expect(legacyHostRedirect.has[0].type).toBe("host");
  });

  it("is wired into the app config", async () => {
    expect(await nextConfig.redirects?.()).toContainEqual(legacyHostRedirect);
  });
});
