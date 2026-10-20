"use client";

import { RotateCw } from "lucide-react";
import "./globals.css";
import dynamic from "next/dynamic";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { Button } from "@clinic/ui/components/ui/button";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { FOOTER_COLUMNS } from "@/lib/footer-links";
import { fontVars } from "@/lib/fonts";
import { SHELL_ROUTES } from "@/lib/shell-routes";
import { FOOTER_NOTICE, SITE } from "@/lib/site";

// The shell is imported lazily: this file is part of every page's client code, and the frame is needed
// only on the rare page that fails (it was 5 KB on every page before).
const PageShell = dynamic(() =>
  import("@clinic/ui/components/layout/page-shell").then((m) => m.PageShell),
);

// Replaces the root layout when the layout itself fails, so it brings its own <html> and the same
// frame as every other page (header, footer, theme). It leaves out the pieces that could be what
// failed: the sign-in menu and the install prompt.
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning style={fontVars}>
      <head>
        <title>Something went wrong</title>
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell
            name={SITE.name}
            navLinks={NAV_LINKS}
            footerColumns={FOOTER_COLUMNS}
            footerNotice={FOOTER_NOTICE}
            routes={SHELL_ROUTES}
          >
            <section role="alert" className="max-w-xl py-16">
              <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                Something went wrong
              </h1>
              <p className="mt-4 text-lg leading-8 text-muted-foreground">
                We could not show this page. Nothing was booked or changed. Try
                again in a moment.
              </p>
              <Button
                onClick={reset}
                size="lg"
                className="mt-6 h-12 gap-2 px-6 text-base"
              >
                <RotateCw aria-hidden className="size-4" /> Try again
              </Button>
            </section>
          </PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
