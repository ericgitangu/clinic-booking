"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";
import { THEME_INIT_SCRIPT } from "@clinic/ui/lib/theme-init";
import { LazyToaster } from "@clinic/ui/components/layout/lazy-toaster";

// Class-based theme that follows the system until a choice is made. next-themes writes the class
// from an inline script before first paint, so there is no flash on load.
export const THEME_PROVIDER_PROPS = {
  attribute: "class",
  defaultTheme: "system",
  enableSystem: true,
  disableTransitionOnChange: true,
} as const;

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      {...THEME_PROVIDER_PROPS}
      // next-themes' own script is made inert (a data block is never run); the one below replaces it.
      scriptProps={{ type: "application/json" }}
    >
      <script
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
      />
      {children}
      <LazyToaster />
    </NextThemesProvider>
  );
}
