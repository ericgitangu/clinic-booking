"use client";

import { Moon, Sun } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";

const load = () =>
  import("@clinic/ui/components/layout/theme-menu").then((m) => m.ThemeMenu);

// The menu (and the dropdown code behind it) is about 35 KB that nothing on screen needs until
// someone taps. This button looks and reads the same, warms the code on hover, focus or touch, and
// swaps in the real menu, already open, on the tap.
function Trigger({ onOpen }: { onOpen?: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11"
      aria-label="Display settings"
      aria-haspopup="menu"
      aria-expanded={false}
      onClick={onOpen}
      onPointerEnter={() => void load()}
      onFocus={() => void load()}
      onTouchStart={() => void load()}
    >
      <Sun className="size-5 dark:hidden" aria-hidden />
      <Moon className="hidden size-5 dark:block" aria-hidden />
    </Button>
  );
}

const ThemeMenu = dynamic(load, { ssr: false, loading: () => <Trigger /> });

export function ThemeToggle() {
  const [open, setOpen] = useState(false);
  return open ? <ThemeMenu /> : <Trigger onOpen={() => setOpen(true)} />;
}
