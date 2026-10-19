import type { ReactNode } from "react";
import "./globals.css";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import { ThemeProvider } from "@clinic/ui/components/layout/theme-provider";
import { Shortcuts } from "@/components/shortcuts";
import { StaffMenu } from "@/components/staff-menu";
import { FOOTER_COLUMNS } from "@/lib/footer";
import { fontVars } from "@/lib/fonts";
import { metadata, viewport } from "@/lib/metadata";
import { getStaff } from "@/lib/session";
import {
  ACCESS_LINK,
  AUDIT_LINK,
  FOOTER_NOTICE,
  NAV_LINKS,
  SITE,
} from "@/lib/site";

export { metadata, viewport };

// The header shows who is signed in, so no page of this app may be prerendered. Without this the
// not-found page was built once at deploy time and showed everyone a header with no session.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // A failed lookup must not break every page; the page itself reports it.
  const staff = await getStaff().catch(() => null);
  const navLinks =
    staff?.role === "owner" || staff?.role === "admin"
      ? [...NAV_LINKS, ACCESS_LINK, AUDIT_LINK]
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
            headerTrailing={
              staff ? (
                <div className="flex items-center">
                  <Shortcuts isOwner={staff.role === "owner"} />
                  <StaffMenu
                    name={staff.name}
                    email={staff.email}
                    image={staff.image}
                    role={staff.role}
                  />
                </div>
              ) : null
            }
          >
            {children}
          </PageShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
