"use client";

import { SerwistProvider } from "@serwist/turbopack/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

// One QueryClient per browser tab. Nothing is persisted: the cache lives in memory and is gone on
// reload, so no appointment or availability data is written to the device.
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <SerwistProvider
      swUrl="/serwist/sw.js"
      // The provider can ask the worker to cache every page the user navigates to and to reload on
      // reconnect; the first would store per-user HTML and the second can drop a half-filled form.
      cacheOnNavigation={false}
      reloadOnOnline={false}
      disable={process.env.NODE_ENV !== "production"}
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SerwistProvider>
  );
}
