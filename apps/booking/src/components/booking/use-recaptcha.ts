"use client";

import { useCallback, useEffect } from "react";

declare global {
  interface Window {
    grecaptcha?: {
      enterprise: {
        ready: (cb: () => void) => void;
        execute: (siteKey: string, opts: { action: string }) => Promise<string>;
      };
    };
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY ?? "";
const SCRIPT_ID = "recaptcha-enterprise";

function load(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.grecaptcha?.enterprise) return resolve();
    let el = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!el) {
      el = document.createElement("script");
      el.id = SCRIPT_ID;
      el.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(SITE_KEY)}`;
      el.async = true;
      document.head.appendChild(el);
    }
    el.addEventListener("load", () => resolve(), { once: true });
    el.addEventListener(
      "error",
      () => reject(new Error("recaptcha script failed")),
      { once: true },
    );
  });
}

// Loads reCAPTCHA Enterprise only on the screens that need it, and returns a function that mints
// a token for one named action. With no site key (local development) it returns an empty string
// and the server decides whether that is acceptable.
export function useRecaptcha(action: string): () => Promise<string> {
  useEffect(() => {
    if (SITE_KEY) void load().catch(() => undefined);
  }, []);
  return useCallback(async () => {
    if (!SITE_KEY) return "";
    await load();
    const g = window.grecaptcha!.enterprise;
    await new Promise<void>((r) => g.ready(r));
    return g.execute(SITE_KEY, { action });
  }, [action]);
}
