"use client";

import { useEffect, useRef } from "react";
import { cn } from "@clinic/ui/lib/utils";

// Decorative rings behind a hero mark (the CSS is in theme.css). The animation stops while the
// tab is hidden, so it never spends battery out of sight. It renders the same on the server and
// the client and takes no space of its own (it is positioned, so it never moves its neighbours).
export function Ripples({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => {
      el.dataset.paused = String(document.visibilityState === "hidden");
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn("ripples pointer-events-none absolute inset-0", className)}
    >
      <span />
      <span />
    </div>
  );
}
