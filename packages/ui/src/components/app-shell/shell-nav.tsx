"use client";

import { MenuIcon, XIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { activeHref, type NavLink } from "@clinic/ui/lib/nav";

const LINK =
  "inline-flex min-h-11 items-center rounded-md px-3 text-base font-medium text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// The one client part of the header: the links (which need the current path for aria-current), the
// phone menu and the lifted look on scroll. The logo, the theme control and whatever the app puts
// beside it (`children`) stay server-rendered. The phone menu is a panel laid over the page, not part
// of the flow, so nothing below the bar moves when it opens.
export function ShellNav({
  links,
  children,
}: {
  links: readonly NavLink[];
  // Rendered between the links and the menu button: who is signed in, the theme control.
  children?: ReactNode;
}) {
  const pathname = usePathname();
  const active = activeHref(links, pathname);
  // The menu is open for the page it was opened on; navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt !== null && openAt === (pathname ?? "");
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const header = () => root.current?.closest("header") ?? null;

  // The lifted look is one attribute, written straight to the element: scrolling never re-renders.
  useEffect(() => {
    const el = header();
    const onScroll = () =>
      el?.setAttribute("data-scrolled", String(window.scrollY > 0));
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Escape closes the menu and gives focus back; tabbing out of the header closes it too.
  useEffect(() => {
    const el = header();
    if (!el || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpenAt(null);
      toggle.current?.focus();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setOpenAt(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) setOpenAt(null);
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <>
      <div ref={root} className="flex shrink-0 items-center">
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
        {children}
        <Button
          ref={toggle}
          variant="ghost"
          size="icon"
          className="size-11 sm:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="shell-menu"
          onClick={() => setOpenAt(open ? null : (pathname ?? ""))}
        >
          {open ? (
            <XIcon className="size-6" aria-hidden />
          ) : (
            <MenuIcon className="size-6" aria-hidden />
          )}
        </Button>
      </div>
      <div
        id="shell-menu"
        hidden={!open}
        className="absolute inset-x-0 top-full max-h-[calc(100dvh-var(--shell-header-offset))] overflow-y-auto border-b border-border bg-background sm:hidden"
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
    </>
  );
}
