"use client";

import { Keyboard } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@clinic/ui/components/ui/dialog";

const KEYS: [string, string][] = [
  ["Tab", "Move to the next link or button"],
  ["Arrow keys", "Move between free times, or between days"],
  ["Home / End", "Jump to the first or last time or day"],
  ["Enter", "Open the details for the focused time"],
  ["?", "Show this list"],
  ["Esc", "Close a dialog"],
];

// Pressing ? opens the list. It never acts while someone is typing (a field, a select, an editable
// area) or while a modifier is held, so it cannot eat a character.
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
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
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard aria-hidden className="size-5" /> Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Everything on this site also works with a mouse or a touch.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
          {KEYS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded-md border border-border bg-muted px-2 py-0.5 font-sans text-sm font-semibold">
                  {k}
                </kbd>
              </dt>
              <dd className="text-muted-foreground">{d}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
