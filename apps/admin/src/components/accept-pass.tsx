"use client";

import { useState, useTransition } from "react";
import { Button } from "@clinic/ui/components/ui/button";
import { notify } from "@clinic/ui/lib/notify";
import { acceptPass } from "@/lib/actions";

// A button, not an automatic step on page load: a link scanner that opens the address must not use
// up a seat on the pass.
export function AcceptPass({ token }: { token: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function accept() {
    start(async () => {
      const res = await acceptPass(token);
      if (res.ok) {
        notify.success(res.message);
        window.location.assign("/dashboard");
      } else {
        setError(res.message);
        notify.error(res.message);
      }
    });
  }

  return (
    <div className="mt-8 space-y-3">
      <Button
        size="lg"
        className="h-11 w-full text-base"
        onClick={accept}
        disabled={pending}
      >
        {pending ? "Accepting" : "Accept"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
