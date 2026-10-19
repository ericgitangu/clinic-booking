"use client";

import { useRef, type ReactNode } from "react";
import { useArrowKeys } from "@/components/booking/use-arrow-keys";

// Left and Right move between the day links (see use-arrow-keys.ts). The server renders the links.
export function ArrowNav({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useArrowKeys(ref, { vertical: false });
  return <div ref={ref}>{children}</div>;
}
