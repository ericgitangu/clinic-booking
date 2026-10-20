import Link from "next/link";
import type { ReactNode } from "react";
import { ShellNav } from "@clinic/ui/components/app-shell/shell-nav";
import { LotusMark } from "@clinic/ui/components/brand/lotus-mark";
import { ThemeToggle } from "@clinic/ui/components/layout/theme-toggle";
import type { NavLink } from "@clinic/ui/lib/nav";

// The sticky bar. 56px tall (plus the notch inset on a phone) at every width. Rendered on the server;
// only the links and the phone menu (ShellNav) run in the browser.
export function ShellHeader({
  name,
  links,
  trailing,
}: {
  name: string;
  links: readonly NavLink[];
  // Whatever the app wants beside the theme control, e.g. who is signed in.
  trailing?: ReactNode;
}) {
  return (
    <header
      data-shell="header"
      data-scrolled="false"
      className="shell-header sticky top-0 z-40 border-b border-border bg-background pt-[env(safe-area-inset-top)]"
    >
      <div className="pad-safe-x mx-auto flex h-[calc(var(--shell-header-h)-1px)] w-full max-w-5xl items-center justify-between gap-2">
        <Link
          href="/"
          className="flex min-h-11 min-w-0 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <LotusMark size={36} className="shrink-0" />
          <span className="truncate font-heading text-base font-semibold leading-tight tracking-tight sm:text-lg">
            {name}
          </span>
        </Link>
        <ShellNav links={links}>
          {trailing}
          <ThemeToggle />
        </ShellNav>
      </div>
    </header>
  );
}
