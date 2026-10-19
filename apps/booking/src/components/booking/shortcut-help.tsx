"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The dialog (and the Radix code under it) is fetched the first time ? is pressed, not with the page.
const Dialog = dynamic(
  () => import("@/components/booking/shortcut-help-dialog"),
  { ssr: false },
);

// Pressing ? opens the list. It never acts while someone is typing (a field, a select, an editable
// area) or while a modifier is held, so it cannot eat a character.
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      e.preventDefault();
      setWanted(true);
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return wanted ? <Dialog open={open} onOpenChange={setOpen} /> : null;
}
