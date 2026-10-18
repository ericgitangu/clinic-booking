import { Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { SessionMenu } from "@/components/account/session-menu";
import { Providers } from "@/components/pwa/providers";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FOOTER_COLUMNS } from "@/lib/footer-links";
import { metadata, viewport } from "@/lib/metadata";
import { FOOTER_NOTICE, SITE } from "@/lib/site";
import { cn } from "@clinic/ui/lib/utils";

// Atkinson Hyperlegible was drawn for legibility, which suits a booking form. One family keeps the
// first load small: a second font file cost about 0.3 s of simulated slow-4G largest contentful paint.
const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "optional",
  // No metrics are published for this font, so Next cannot size a fallback; ask for plain system fonts instead of warning.
  adjustFontFallback: false,
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export { metadata, viewport };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn(sans.variable)}>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <Providers>
            <PageShell
              name={SITE.name}
              navLinks={NAV_LINKS}
              footerColumns={FOOTER_COLUMNS}
              footerNotice={FOOTER_NOTICE}
              headerTrailing={<SessionMenu />}
            >
              {children}
            </PageShell>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
