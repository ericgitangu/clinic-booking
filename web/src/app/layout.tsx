import { Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@/components/layout/page-shell";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { metadata, viewport } from "@/lib/metadata";
import { cn } from "@/lib/utils";

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
          <PageShell>{children}</PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
