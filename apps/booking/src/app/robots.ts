import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

// Crawlers may read the public pages. The API, the admin area, sign-in and scheduled work are not content.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin", "/auth", "/cron"],
    },
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
