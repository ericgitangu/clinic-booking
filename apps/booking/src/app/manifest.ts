import type { MetadataRoute } from "next";
import { SITE, THEME_COLORS } from "@/lib/site";

// What a phone needs to install the site as an app. The colours are the page background, so the
// splash screen and the title bar match the first paint. A manifest has one theme colour; dark
// mode is handled by the theme-color tags in the page head (see lib/metadata.ts).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: SITE.name,
    short_name: SITE.shortName,
    description: SITE.description,
    lang: "en-KE",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    categories: ["health", "medical", "lifestyle"],
    background_color: THEME_COLORS.light,
    theme_color: THEME_COLORS.light,
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon/maskable-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Book a visit",
        short_name: "Book",
        description: "Choose a doctor and a free time.",
        url: "/book",
        icons: [{ src: "/icon/192", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "My appointments",
        short_name: "Appointments",
        description: "See, cancel or move your appointments.",
        url: "/appointments",
        icons: [{ src: "/icon/192", sizes: "192x192", type: "image/png" }],
      },
    ],
    screenshots: [
      {
        src: "/screenshots/book-wide.webp",
        sizes: "1280x720",
        type: "image/webp",
        form_factor: "wide",
        label: "Choosing a free time with a doctor",
      },
      {
        src: "/screenshots/book-narrow.webp",
        sizes: "360x640",
        type: "image/webp",
        form_factor: "narrow",
        label: "Choosing a free time with a doctor, on a phone",
      },
    ],
  };
}
