"use client";

import { useEffect } from "react";

// Marks <html data-hydrated> once React has hydrated the shell and its effects have run. Tests wait
// on it instead of guessing from load events or network idle (pages that poll never go idle). It is
// set in an effect, never rendered, so the server output is identical and nothing can mismatch. It is
// cleared on unmount so a stale mark never outlives the tree that set it.
export function HydrationSignal() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.hydrated = "true";
    return () => {
      delete root.dataset.hydrated;
    };
  }, []);
  return null;
}
