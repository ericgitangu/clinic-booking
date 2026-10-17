import { Atkinson_Hyperlegible_Next, Sora } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@/components/layout/page-shell";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { metadata, viewport } from "@/lib/metadata";
import { cn } from "@/lib/utils";

// Atkinson Hyperlegible was drawn for legibility, which suits a booking form; Sora's wide
// geometric caps sit close to the Idyllic wordmark.
const sans = Atkinson_Hyperlegible_Next({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const display = Sora({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export { metadata, viewport };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(sans.variable, display.variable)}
    >
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell>{children}</PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
