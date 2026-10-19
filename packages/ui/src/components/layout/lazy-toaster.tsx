"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { onToasterRequested } from "@clinic/ui/lib/toaster-gate";

// The toaster is not needed to paint the page, so its code loads when something raises the first
// toast (see lib/toaster-gate.ts and lib/notify.ts), not with the page and not on idle: an idle
// preload still runs inside the load window Lighthouse measures, and most visits never toast.
const Toaster = dynamic(
  () => import("@clinic/ui/components/ui/sonner").then((m) => m.Toaster),
  { ssr: false },
);

export function LazyToaster() {
  const [wanted, setWanted] = useState(false);
  useEffect(() => onToasterRequested(() => setWanted(true)), []);
  return wanted ? <Toaster position="top-center" /> : null;
}
