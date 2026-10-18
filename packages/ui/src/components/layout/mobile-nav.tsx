"use client";

import { MenuIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import type { NavLink } from "@clinic/ui/lib/nav";

const load = () =>
  import("@clinic/ui/components/layout/mobile-menu").then((m) => m.MobileMenu);

// Phone navigation. The sheet's code loads on the first tap (or when a finger lands on the button),
// not with the page; until then this is the same button.
function Trigger({ onOpen }: { onOpen?: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 sm:hidden"
      aria-label="Open menu"
      aria-haspopup="dialog"
      aria-expanded={false}
      onClick={onOpen}
      onPointerEnter={() => void load()}
      onFocus={() => void load()}
      onTouchStart={() => void load()}
    >
      <MenuIcon className="size-6" aria-hidden />
    </Button>
  );
}

const MobileMenu = dynamic(load, { ssr: false, loading: () => <Trigger /> });

export function MobileNav({ links }: { links: readonly NavLink[] }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <MobileMenu links={links} />
  ) : (
    <Trigger onOpen={() => setOpen(true)} />
  );
}
