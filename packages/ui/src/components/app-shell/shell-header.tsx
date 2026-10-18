"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LotusMark } from "@clinic/ui/components/brand/lotus-mark";
import { ThemeToggle } from "@clinic/ui/components/layout/theme-toggle";
import { Button } from "@clinic/ui/components/ui/button";
import { activeHref, type NavLink } from "@clinic/ui/lib/nav";
import { cn } from "@clinic/ui/lib/utils";

const LINK =
  "inline-flex min-h-11 items-center rounded-md px-3 text-base font-medium text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// The sticky bar. 56px tall (plus the notch inset on a phone) at every width, so nothing below it
// moves when the menu opens: the phone menu is a panel laid over the page, not part of the flow.
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
  const pathname = usePathname();
  const active = activeHref(links, pathname);
  const [scrolled, setScrolled] = useState(false);
  // The menu is open for the page it was opened on; navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt !== null && openAt === (pathname ?? "");
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!header.current?.contains(e.target as Node)) setOpenAt(null);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpenAt(null);
    if (returnFocus) toggle.current?.focus();
  };

  return (
    <header
      ref={header}
      data-shell="header"
      data-scrolled={scrolled}
      className="shell-header sticky top-0 z-40 border-b border-border bg-background pt-[env(safe-area-inset-top)]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        // Tabbing out of the header closes the menu; focus moving inside it does not.
        if (open && !header.current?.contains(e.relatedTarget as Node | null))
          setOpenAt(null);
      }}
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
        <div className="flex shrink-0 items-center">
          <nav aria-label="Primary" className="hidden items-center sm:flex">
            {/* Wide screens show the links marked inline; the rest live in the phone menu. */}
            {links
              .filter((l) => l.inline)
              .map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  className={LINK}
                  aria-current={l.href === active ? "page" : undefined}
                >
                  {l.label}
                </a>
              ))}
          </nav>
          {trailing}
          <ThemeToggle />
          <Button
            ref={toggle}
            variant="ghost"
            size="icon"
            className="size-11 sm:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="shell-menu"
            onClick={() => (open ? close(false) : setOpenAt(pathname ?? ""))}
          >
            {open ? (
              <XIcon className="size-6" aria-hidden />
            ) : (
              <MenuIcon className="size-6" aria-hidden />
            )}
          </Button>
        </div>
      </div>
      <div
        id="shell-menu"
        hidden={!open}
        className={cn(
          "absolute inset-x-0 top-full max-h-[calc(100dvh-var(--shell-header-offset))] overflow-y-auto border-b border-border bg-background sm:hidden",
        )}
      >
        <nav
          aria-label="Menu"
          className="pad-safe-x mx-auto flex w-full max-w-5xl flex-col py-2"
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="flex min-h-12 items-center rounded-md px-2 text-base font-medium hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-semibold focus-visible:outline-2 focus-visible:outline-ring"
              aria-current={l.href === active ? "page" : undefined}
              onClick={() => setOpenAt(null)}
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
