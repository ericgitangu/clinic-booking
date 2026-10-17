import type { Metadata, Viewport } from "next";
import { SITE, THEME_COLORS } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: SITE.name, template: `%s | ${SITE.name}` },
  applicationName: SITE.name,
  description: SITE.description,
  // Staff only: keep it out of search results.
  robots: { index: false, follow: false },
  // A link pasted into chat still previews with the brand; the image is app/opengraph-image.tsx.
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: SITE.name,
    description: SITE.description,
    locale: SITE.locale,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.name,
    description: SITE.description,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
  ],
};
