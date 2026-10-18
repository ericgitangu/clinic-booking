"use client";

import { RotateCw } from "lucide-react";
import { Button } from "@clinic/ui/components/ui/button";

// Anything a page throws lands here instead of a blank screen, with a way to try again.
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="max-w-xl py-16">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Something went wrong
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        We could not show this page. Nothing was booked or changed. Try again in
        a moment.
      </p>
      <Button
        onClick={reset}
        size="lg"
        className="mt-6 h-12 gap-2 px-6 text-base"
      >
        <RotateCw aria-hidden className="size-4" /> Try again
      </Button>
    </section>
  );
}
