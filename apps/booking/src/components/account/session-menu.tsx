"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { AUTH_BASE_PATH } from "@/lib/auth-config";

// The sign-in client and the account menu (Better Auth, the Radix dropdown and its focus code) are
// about 125 KB of script that a signed-out visitor never sees. They load only once the server says
// this browser has a session.
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

// The same endpoint Better Auth's hook reads, with a plain fetch. The session cookie is httpOnly,
// so asking the server is the only way to know. Any failure reads as signed out, which is what the
// header showed before this check existed when the session could not be read.
export async function hasSession(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_BASE_PATH}/get-session`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "session" in body &&
      body.session != null
    );
  } catch {
    return false;
  }
}

// Who is signed in, shown beside the theme control; signing out is one tap. It reads the session in
// the browser so the pages that do not need an account (the landing page, the legal pages) stay
// static. Signed out shows nothing: the pages that need an account say so themselves. A tab that
// comes back to the front asks again, so a sign-in in another tab still shows here; once signed in,
// Better Auth's hook follows the session from then on.
export function SessionMenu() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (signedIn) return;
    const ctrl = new AbortController();
    let busy = false;
    const check = () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      void hasSession(ctrl.signal).then((yes) => {
        busy = false;
        if (yes && !ctrl.signal.aborted) setSignedIn(true);
      });
    };
    const cancelIdle = whenIdle(check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelIdle();
      ctrl.abort();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [signedIn]);
  return signedIn ? <Who /> : null;
}
