"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

// One QueryClient per browser tab, shared by every provider below it (a module singleton in the
// browser, a fresh one per render on the server). Nothing is persisted: the cache lives in memory and
// is gone on reload, so no appointment or availability data is written to the device.
let browserClient: QueryClient | undefined;
function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
  });
}
function clientForRender(): QueryClient {
  if (typeof window === "undefined") return makeClient();
  return (browserClient ??= makeClient());
}

// Only the pages that read or write availability and bookings sit under this (see the layouts in
// app/book and app/appointments), so the landing and legal pages do not load the query library.
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(clientForRender);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
