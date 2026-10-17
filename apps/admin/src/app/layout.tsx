import { Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { cn } from "@clinic/ui/lib/utils";
import { FOOTER_COLUMNS } from "@/lib/footer";
import { metadata, viewport } from "@/lib/metadata";
import { FOOTER_NOTICE, NAV_LINKS, SITE } from "@/lib/site";

const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "optional",
  adjustFontFallback: false,
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export { metadata, viewport };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn(sans.variable)}>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell
            name={SITE.name}
            navLinks={NAV_LINKS}
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
