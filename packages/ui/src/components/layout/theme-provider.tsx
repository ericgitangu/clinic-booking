"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";
import { LazyToaster } from "@clinic/ui/components/layout/lazy-toaster";

// Class-based theme that follows the system until a choice is made. next-themes writes the class
// from an inline script before first paint, so there is no flash on load.
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
      <LazyToaster />
    </NextThemesProvider>
  );
}
