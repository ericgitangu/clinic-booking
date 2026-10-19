import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { SessionMenu } from "@/components/account/session-menu";
import { ShortcutHelp } from "@/components/booking/shortcut-help";
import { ServiceWorker } from "@/components/pwa/service-worker";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FOOTER_COLUMNS } from "@/lib/footer-links";
import { fontVars } from "@/lib/fonts";
import { metadata, viewport } from "@/lib/metadata";
import { FOOTER_NOTICE, SITE } from "@/lib/site";

// Atkinson Hyperlegible was drawn for legibility, which suits a booking form. One family keeps the
// first load small: a second font file cost about 0.3 s of simulated slow-4G largest contentful paint.
export { metadata, viewport };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning style={fontVars}>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell
            name={SITE.name}
            navLinks={NAV_LINKS}
            footerColumns={FOOTER_COLUMNS}
            footerNotice={FOOTER_NOTICE}
            headerTrailing={<SessionMenu />}
          >
            {children}
          </PageShell>
          <ShortcutHelp />
          <ServiceWorker />
        </ThemeProvider>
      </body>
    </html>
  );
}
