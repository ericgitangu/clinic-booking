"use client";

import { useState } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { authClient } from "@/lib/auth-client";

export function SignInButton() {
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const res = await authClient.signIn.social({
      provider: "google",
      callbackURL: "/dashboard",
    });
    if (res.error) {
      setBusy(false);
      notify.error("Could not start Google sign-in. Try again.");
    }
  }

  return (
    <Button
      size="lg"
      className="mt-8 h-11 w-full text-base"
      onClick={signIn}
      disabled={busy}
    >
      {busy ? "Opening Google" : "Sign in with Google"}
    </Button>
  );
}
