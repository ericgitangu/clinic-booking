"use client";

import { MenuIcon } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@clinic/ui/components/ui/sheet";
import type { NavLink } from "@clinic/ui/lib/nav";

// Phone navigation: a sheet from the side, thumb-sized rows. Wider screens show the links inline.
export function MobileNav({ links }: { links: readonly NavLink[] }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:hidden"
          aria-label="Open menu"
        >
          <MenuIcon className="size-6" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-72 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Where to go on this site.</SheetDescription>
        </SheetHeader>
        <nav aria-label="Menu" className="flex flex-col px-4">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="flex min-h-12 items-center rounded-md px-2 text-base font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
