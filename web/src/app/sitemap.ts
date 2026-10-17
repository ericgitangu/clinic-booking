import type { MetadataRoute } from "next";
import { PUBLIC_PATHS, SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((p) => ({ url: `${SITE.url}${p === "/" ? "" : p}` }));
}
