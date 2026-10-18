"use client";

import { useEffect, useState } from "react";

// A key that identifies one booking attempt. It stays the same while the attempt does (a retry
// after a lost response, a second click), and is replaced as soon as `scope` changes, because the
// API ties a key to the doctor and time it first came with.
//
// It is made in an effect, not during render, so the server-rendered page and the first client
// render agree (the key is empty until the page has hydrated, and so is the submit button).
export function useAttemptKey(scope: string): string {
  const [key, setKey] = useState("");
  useEffect(() => {
    setKey(crypto.randomUUID());
  }, [scope]);
  return key;
}
