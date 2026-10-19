import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import robots from "@/app/robots";
import { metadata, viewport } from "@/lib/metadata";
import nextConfig from "../next.config";
import { SITE, THEME_COLORS } from "@/lib/site";

describe("admin branding and metadata", () => {
  it("has an absolute base, a title template and share cards", () => {
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

  it("stays out of search results even with a title and icons", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
  });

  it("puts the theme colour in the viewport export, one per colour scheme", () => {
    const colours = viewport.themeColor as { media: string; color: string }[];
    expect(colours.map((c) => c.color)).toEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
    expect("themeColor" in metadata).toBe(false);
  });

  it("declares an installable app with 192 and 512 pixel icons", () => {
    const m = manifest();
    expect(m).toMatchObject({
      start_url: "/",
      display: "standalone",
      name: SITE.name,
      short_name: SITE.shortName,
    });
    expect(m.icons?.map((i) => i.sizes)).toEqual(["192x192", "512x512"]);
  });

  it("names the app's own host for server actions, the same host as SITE.url", () => {
    expect(nextConfig.experimental?.serverActions?.allowedOrigins).toEqual([
      new URL(SITE.url).host,
    ]);
  });
});
