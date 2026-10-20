"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { cardKey, highlights } from "@/lib/live-notices";

/**
 * A doctor's card on the today board. For two seconds after one of the doctor's visits changes it
 * is outlined (and pulses, unless the person asked for less motion) and carries the word
 * "Updated" on its edge, so the signal is not a colour. The word carries the doctor's name for a
 * screen reader ("Updated: Dr. Otieno") but is not a live region: the toast and the feed already
 * announce the event, and a card per announcement would repeat it several times in a burst. The
 * outline is drawn outside the box and the word sits on the border, so nothing around the card
 * moves.
 */
/** The word on the card's edge. Nothing is rendered when the card is not marked. */
export function UpdatedTag({
  changed,
  doctorName,
}: {
  changed: boolean;
  doctorName: string;
}) {
  if (!changed) return null;
  return (
    <span
      className="absolute -top-2.5 left-4 rounded-sm border border-border bg-card px-1.5 text-xs font-medium"
      data-testid="today-updated"
    >
      Updated<span className="sr-only">: {doctorName}</span>
    </span>
  );
}

export function TodayCard({
  doctorId,
  doctorName,
  date,
  children,
  ...rest
}: {
  doctorId: string;
  doctorName: string;
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
      <UpdatedTag changed={changed} doctorName={doctorName} />
      {children}
    </li>
  );
}
