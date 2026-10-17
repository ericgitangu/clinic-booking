import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { cn } from "@clinic/ui/lib/utils";
import { FOOTER_COLUMNS } from "@/lib/footer";
import { metadata, viewport } from "@/lib/metadata";
import { getStaff } from "@/lib/session";
import { ACCESS_LINK, FOOTER_NOTICE, NAV_LINKS, SITE } from "@/lib/site";

const sans = localFont({
  // Variable weight, latin subset, committed under src/fonts (SIL OFL 1.1, licence beside it): the build needs no network.
  src: "../fonts/AtkinsonHyperlegibleNext-latin-wght.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-sans",
  display: "optional",
  adjustFontFallback: false,
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export { metadata, viewport };

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // A failed lookup must not break every page; the page itself reports it.
  const staff = await getStaff().catch(() => null);
  const navLinks =
    staff?.role === "owner" ? [...NAV_LINKS, ACCESS_LINK] : [...NAV_LINKS];
  return (
    <html lang="en" suppressHydrationWarning className={cn(sans.variable)}>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell
            name={SITE.name}
            navLinks={navLinks}
            footerColumns={FOOTER_COLUMNS}
            footerNotice={FOOTER_NOTICE}
          >
            {children}
          </PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
