"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The worker registers once the page has settled, not in the first load: nothing a visitor sees needs
// it, so its code stays out of the critical path.
const Serwist = dynamic(
  () => import("@serwist/turbopack/react").then((m) => m.SerwistProvider),
  { ssr: false },
);

export function ServiceWorker() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const go = () => setReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(go, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(go, 2000);
    return () => window.clearTimeout(id);
  }, []);
  if (!ready) return null;
  return (
    <Serwist
      swUrl="/serwist/sw.js"
      // The provider can ask the worker to cache every page the user navigates to and to reload on
      // reconnect; the first would store per-user HTML and the second can drop a half-filled form.
      cacheOnNavigation={false}
      reloadOnOnline={false}
    >
      {null}
    </Serwist>
  );
}
