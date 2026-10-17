"use client";

import dynamic from "next/dynamic";

// The toaster is not needed to paint the page, so its code loads after the page is interactive.
const Toaster = dynamic(
  () => import("@clinic/ui/components/ui/sonner").then((m) => m.Toaster),
  { ssr: false },
);

export function LazyToaster() {
  return <Toaster position="top-center" />;
}
