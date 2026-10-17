"use client";

import { Button } from "@clinic/ui/components/ui/button";

// Fixed copy on purpose: the cause (status and code) is in the server log, not on screen.
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <section className="mx-auto max-w-md py-16" role="alert">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        The dashboard could not load
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        The clinic service did not answer. Nothing was changed. Try again in a
        moment.
      </p>
      <Button className="mt-6 min-h-11" onClick={reset}>
        Try again
      </Button>
    </section>
  );
}
