import type { ReactNode } from "react";
import { SiteFooter } from "@clinic/ui/components/layout/site-footer";
import { SiteHeader } from "@clinic/ui/components/layout/site-header";
import type { FooterColumn } from "@clinic/ui/lib/footer";
import type { NavLink } from "@clinic/ui/lib/nav";

// The frame every page shares: skip link, header, the main landmark, footer.
export function PageShell({
  children,
  name,
  navLinks,
  footerColumns,
  footerNotice,
  headerTrailing,
}: {
  children: ReactNode;
  name: string;
  navLinks: readonly NavLink[];
  footerColumns: readonly FooterColumn[];
  footerNotice: string;
  headerTrailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <SiteHeader name={name} links={navLinks} trailing={headerTrailing} />
      <main id="main" className="pad-safe-x mx-auto w-full max-w-5xl flex-1">
        {children}
      </main>
      <SiteFooter columns={footerColumns} notice={footerNotice} />
    </div>
  );
}
