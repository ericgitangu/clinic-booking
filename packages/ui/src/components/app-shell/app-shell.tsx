import type { ReactNode } from "react";
import { ShellHeader } from "@clinic/ui/components/app-shell/shell-header";
import { ShellTrail } from "@clinic/ui/components/app-shell/shell-trail";
import { SiteFooter } from "@clinic/ui/components/layout/site-footer";
import type { FooterColumn } from "@clinic/ui/lib/footer";
import type { NavLink } from "@clinic/ui/lib/nav";
import type { ShellRoutes } from "@clinic/ui/lib/shell-trail";

// The frame every route shares, 404 and error pages included: skip link, sticky header, the way
// back, the main landmark, footer. The root layout of each app wraps `children` in this once.
export function AppShell({
  children,
  name,
  navLinks,
  footerColumns,
  footerNotice,
  headerTrailing,
  routes,
}: {
  children: ReactNode;
  name: string;
  navLinks: readonly NavLink[];
  footerColumns: readonly FooterColumn[];
  footerNotice: string;
  headerTrailing?: ReactNode;
  // The app's route list (src/lib/shell-routes.ts); without it no back link is drawn.
  routes?: ShellRoutes;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-[calc(env(safe-area-inset-top)+0.5rem)] focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Skip to content
      </a>
      <ShellHeader name={name} links={navLinks} trailing={headerTrailing} />
      {routes ? <ShellTrail config={routes} /> : null}
      <main
        id="main"
        tabIndex={-1}
        className="pad-safe-x mx-auto w-full max-w-5xl flex-1 outline-none"
      >
        {children}
      </main>
      <SiteFooter columns={footerColumns} notice={footerNotice} />
    </div>
  );
}
