import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata, viewport } from "@/lib/metadata";
import { SITE, THEME_COLORS } from "@/lib/site";

describe("search and sharing metadata", () => {
  it("sets a title template and an absolute base so share links resolve", () => {
    expect(new URL(String(metadata.metadataBase)).href).toBe(`${SITE.url}/`);
    expect(metadata.title).toMatchObject({
      default: SITE.name,
      template: `%s | ${SITE.name}`,
    });
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: SITE.name,
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("puts the theme colour in the viewport export, one per colour scheme", () => {
    const colours = viewport.themeColor as { media: string; color: string }[];
    expect(colours.map((c) => c.color)).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
    expect(colours[1].media).toContain("dark");
    expect("themeColor" in metadata).toBe(false);
  });

  it("lists the public pages in the sitemap", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain(SITE.url);
    expect(urls).toContain(`${SITE.url}/docs`);
    for (const p of ["/privacy", "/terms", "/openapi.json"])
      expect(urls).toContain(`${SITE.url}${p}`);
  });

  it("keeps crawlers out of the API, admin, sign-in and cron routes and points at the sitemap", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toEqual(
      expect.arrayContaining(["/api/", "/admin", "/auth", "/cron"]),
    );
    expect(r.sitemap).toBe(`${SITE.url}/sitemap.xml`);
  });

  it("declares an installable app with 192 and 512 pixel icons", () => {
    const m = manifest();
    expect(m).toMatchObject({
      start_url: "/",
      display: "standalone",
      name: SITE.name,
    });
    expect(m.icons?.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  });
});
