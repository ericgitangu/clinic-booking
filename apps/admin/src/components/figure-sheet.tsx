"use client";

import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@clinic/ui/components/ui/sheet";

// The detail of a figure the API gives only as a number: what it is, the numbers around it, and
// plainly what cannot be listed yet and why. Opens like every other detail view (a bottom sheet,
// focus trapped, Esc closes and returns focus), for every role: it holds no names and no reasons.
export function FigureSheet({
  title,
  description,
  className,
  trigger,
  children,
  gap,
}: {
  title: string;
  description: string;
  /** Classes for the trigger button. */
  className?: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  /** The numbers, as server-rendered content. */
  children: ReactNode;
  /** Why the visits behind this figure cannot be listed, in plain words. Named, never hidden. */
  gap: string;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button type="button" aria-haspopup="dialog" className={className}>
          {trigger}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[88dvh] w-full gap-3 overflow-y-auto rounded-t-2xl p-0 sm:max-w-3xl"
      >
        <SheetHeader className="px-4 pt-4 pr-12">
          <SheetTitle className="font-heading text-lg">{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-5">
          <div data-testid="figure-numbers">{children}</div>
          <p
            className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground"
            data-testid="figure-gap"
          >
            {gap}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
