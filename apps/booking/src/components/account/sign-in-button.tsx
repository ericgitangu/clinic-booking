"use client";

import { useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";

// Starts Google sign-in and comes back to `returnTo` (a path on this site).
export function SignInButton({
  returnTo,
  className,
  size = "lg",
}: {
  returnTo: string;
  className?: string;
  size?: "default" | "lg";
}) {
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const res = await authClient.signIn.social({
      provider: "google",
      callbackURL: returnTo,
    });
    if (res.error) {
      setBusy(false);
      notify.error("Could not start Google sign-in. Try again.");
    }
  }

  return (
    <Button
      size={size}
      className={className ?? "h-12 text-base"}
      onClick={signIn}
      disabled={busy}
    >
      {busy ? "Opening Google" : "Sign in with Google"}
    </Button>
  );
}
