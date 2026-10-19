"use client";

import "./globals.css";
import dynamic from "next/dynamic";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { Button } from "@clinic/ui/components/ui/button";
import { FOOTER_COLUMNS } from "@/lib/footer";
import { fontVars } from "@/lib/fonts";
import { SHELL_ROUTES } from "@/lib/shell-routes";
import { FOOTER_NOTICE, NAV_LINKS, SITE } from "@/lib/site";

// The shell is imported lazily: this file is part of every page's client code, and the frame is needed
// only on the rare page that fails (it was 5 KB on every page before).
const PageShell = dynamic(() =>
  import("@clinic/ui/components/layout/page-shell").then((m) => m.PageShell),
);

// Replaces the root layout when the layout itself fails, so it brings its own <html> and the same
// frame as every other page. It cannot look up who is signed in (that lookup may be what failed),
// so the header shows the signed-out links only.
export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning style={fontVars}>
      <head>
        <title>The dashboard could not load</title>
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
            <section className="mx-auto max-w-md py-16" role="alert">
              <h1 className="font-heading text-3xl font-semibold tracking-tight">
                The dashboard could not load
              </h1>
              <p className="mt-4 text-lg leading-8 text-muted-foreground">
                Something failed before the page could be drawn. Nothing was
                changed. Try again in a moment.
              </p>
              <Button className="mt-6 min-h-11" onClick={reset}>
                Try again
              </Button>
            </section>
          </PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
