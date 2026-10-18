"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The sign-in client is not needed to paint and weighs more than the rest of the header together,
// so it loads once the page is idle (and brings its session hook with it).
const Who = dynamic(
  () => import("@/components/account/session-who").then((m) => m.SessionWho),
  { ssr: false },
);

// Runs the callback once the browser is idle, so the page has painted before the work starts.
const whenIdle = (fn: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
};

// Who is signed in, shown beside the theme control; signing out is one tap. It reads the session in
// the browser so the pages that do not need an account (the landing page, the legal pages) stay
// static. Signed out shows nothing: the pages that need an account say so themselves.
export function SessionMenu() {
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true)), []);
  return ready ? <Who /> : null;
}
