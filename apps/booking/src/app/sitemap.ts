import type { MetadataRoute } from "next";
import { listDoctors } from "@/lib/api";
import { PUBLIC_PATHS, SITE } from "@/lib/site";

// The doctor list comes from the API at request time (cached five minutes by the call itself), so
// the build never needs the API and a new doctor appears without a deploy. If the API is down the
// sitemap still answers with the fixed pages: a crawler should see a short list, not an error.
export const dynamic = "force-dynamic";

const at = (path: string) => `${SITE.url}${path === "/" ? "" : path}`;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages = PUBLIC_PATHS.map((p) => ({ url: at(p) }));
  const doctors = await listDoctors();
  if (!doctors.ok) return pages;
  return [
    ...pages,
    ...doctors.data.items.map((d) => ({ url: at(`/book/${d.id}`) })),
  ];
}
