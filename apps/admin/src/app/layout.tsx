import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { FOOTER_COLUMNS } from "@/lib/footer";
import { fontVars } from "@/lib/fonts";
import { metadata, viewport } from "@/lib/metadata";
import { SHELL_ROUTES, SIGNED_OUT_NAV } from "@/lib/shell-routes";
import { getStaff } from "@/lib/session";
import { ACCESS_LINK, FOOTER_NOTICE, NAV_LINKS, SITE } from "@/lib/site";

export { metadata, viewport };

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // A failed lookup must not break every page; the page itself reports it.
  const staff = await getStaff().catch(() => null);
  const navLinks = !staff
    ? [...SIGNED_OUT_NAV]
    : staff.role === "owner"
      ? [...NAV_LINKS, ACCESS_LINK]
      : [...NAV_LINKS];
  return (
    <html lang="en" suppressHydrationWarning style={fontVars}>
      <body className="min-h-dvh font-sans antialiased">
        <ThemeProvider>
          <PageShell
            name={SITE.name}
            navLinks={navLinks}
            footerColumns={FOOTER_COLUMNS}
            footerNotice={FOOTER_NOTICE}
            routes={SHELL_ROUTES}
          >
            {children}
          </PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
