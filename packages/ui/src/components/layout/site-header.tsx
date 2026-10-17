import Link from "next/link";
import { LotusMark } from "@clinic/ui/components/brand/lotus-mark";
import { MobileNav } from "@clinic/ui/components/layout/mobile-nav";
import { ThemeToggle } from "@clinic/ui/components/layout/theme-toggle";
import type { NavLink } from "@clinic/ui/lib/nav";

export function SiteHeader({
  name,
  links,
}: {
  name: string;
  links: readonly NavLink[];
}) {
  return (
    <header className="border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="pad-safe-x mx-auto flex h-16 w-full max-w-5xl items-center justify-between">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <LotusMark size={36} />
          <span className="font-heading text-base font-semibold leading-tight tracking-tight sm:text-lg">
            {name}
          </span>
        </Link>
        <div className="flex items-center">
          <nav aria-label="Primary" className="hidden items-center sm:flex">
            {/* The docs link is the only one wide screens need; the rest live in the phone menu. */}
            <a
              href={links[0].href}
              className="inline-flex min-h-11 items-center rounded-md px-3 text-base font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {links[0].label}
            </a>
          </nav>
          <ThemeToggle />
          <MobileNav links={links} />
        </div>
      </div>
    </header>
  );
}
