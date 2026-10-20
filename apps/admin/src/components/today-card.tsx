"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { cardKey, highlights } from "@/lib/live-notices";

/**
 * A doctor's card on the today board. For two seconds after one of the doctor's visits changes it
 * is outlined (and pulses, unless the person asked for less motion) and carries the word
 * "Updated" on its edge, so the signal is not a colour: the outline appears, the word appears and
 * a screen reader hears it. The outline is drawn outside the box and the word sits on the border,
 * so nothing around the card moves.
 */
export function TodayCard({
  doctorId,
  date,
  children,
  ...rest
}: {
  doctorId: string;
  date: string;
  children: ReactNode;
  "data-testid"?: string;
  className?: string;
}) {
  const key = cardKey(doctorId, date);
  const changed = useSyncExternalStore(
    (l) => highlights.subscribe(l),
    () => highlights.has(key),
    () => false,
  );
  return (
    <li
      {...rest}
      data-changed={changed ? "true" : undefined}
      className={`relative ${rest.className ?? ""} ${changed ? "live-changed outline-2 outline-offset-2 outline-ring" : ""}`}
    >
      <span
        aria-live="polite"
        className={
          changed
            ? "absolute -top-2.5 left-4 rounded-sm border border-border bg-card px-1.5 text-xs font-medium"
            : "sr-only"
        }
        data-testid="today-updated"
      >
        {changed ? "Updated" : ""}
      </span>
      {children}
    </li>
  );
}
