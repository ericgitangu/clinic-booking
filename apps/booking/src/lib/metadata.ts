import type { Metadata, Viewport } from "next";
import { SITE, THEME_COLORS } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: SITE.name, template: `%s | ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
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
  // Installed from the home screen on iOS, the site opens full screen under its own short name.
  appleWebApp: { capable: true, title: SITE.shortName },
  formatDetection: { telephone: false },
};

// The title, canonical address and share card for one indexable page. A page that sets its own
// openGraph would otherwise drop the site-wide card and show the home page's address.
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  // A page that sets openGraph replaces the site-wide one, share card included, so name it again.
  const card = [
    {
      url: "/opengraph-image",
      width: 1200,
      height: 630,
      alt: `${SITE.name}: book a doctor's visit in Nairobi`,
    },
  ];
  const full = title === SITE.name ? title : `${title} | ${SITE.name}`;
  return {
    title: title === SITE.name ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      locale: SITE.locale,
      title: full,
      description,
      url: path,
      images: card,
    },
    twitter: {
      card: "summary_large_image",
      title: full,
      description,
      images: card,
    },
  };
}

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
