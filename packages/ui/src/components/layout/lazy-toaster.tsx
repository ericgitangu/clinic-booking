"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { onToasterRequested } from "@clinic/ui/lib/toaster-gate";

// The toaster is not needed to paint the page, so its code loads once the page is idle, or at once
// when something raises a toast (see lib/toaster-gate.ts and lib/notify.ts).
const Toaster = dynamic(
  () => import("@clinic/ui/components/ui/sonner").then((m) => m.Toaster),
  { ssr: false },
);

export function LazyToaster() {
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    const want = () => setWanted(true);
    const off = onToasterRequested(want);
    const id =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(want, { timeout: 4000 })
        : window.setTimeout(want, 1500);
    return () => {
      off();
      if (typeof window.cancelIdleCallback === "function")
        window.cancelIdleCallback(id);
      window.clearTimeout(id);
    };
  }, []);
  return wanted ? <Toaster position="top-center" /> : null;
}
