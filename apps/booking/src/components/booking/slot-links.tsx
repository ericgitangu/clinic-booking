import Link from "next/link";
import { memo, useEffect, useRef } from "react";
import { useArrowKeys } from "@/components/booking/use-arrow-keys";
import { formatTime } from "@/lib/clinic-time";
import type { Chip } from "@/lib/slot-chips";

export const detailsHref = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;

// The time grid on the doctor page. A free time is a real link straight to its details page, so
// it works with a keyboard, a screen reader, middle click and no script. Every other time stays on
// the grid, in place, as plain text with the reason beside it: no link, no tab stop. Which state a
// time is in is decided by lib/slot-chips.ts; this is a plain function of its props.
export const SlotLinks = memo(function SlotLinks({
  chips,
  doctorId,
  trackRenders = false,
}: {
  chips: readonly Chip[];
  doctorId: string;
  /** Test runs only (lib/test-run.ts): write the render count into data-renders. */
  trackRenders?: boolean;
}) {
  // Written to the DOM after each commit (no state, so no render). The render-count tests read it:
  // a poll that changes nothing must not move it.
  const field = useRef<HTMLFieldSetElement>(null);
  const renders = useRef(0);
  useArrowKeys(field, { vertical: true });
  useEffect(() => {
    renders.current += 1;
    if (trackRenders)
      field.current?.setAttribute("data-renders", String(renders.current));
  });
  return (
    <fieldset ref={field}>
      <legend className="sr-only">Times</legend>
      <ul className="slot-grid grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {chips.map((c) => {
          const time = formatTime(c.starts_at);
          return (
            <li key={c.starts_at} data-state={c.state} data-time={time}>
              {c.state === "free" ? (
                <Link
                  href={detailsHref(doctorId, c.starts_at)}
                  className="slot-chip-label flex min-h-14 flex-col items-center justify-center rounded-lg border border-border bg-card px-1 text-center text-base font-semibold motion-safe:transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <span>{time}</span>
                  <span className="sr-only">free, book this time</span>
                </Link>
              ) : (
                <span className="slot-chip-label flex min-h-14 flex-col items-center justify-center rounded-lg border border-dashed border-muted-foreground/50 bg-muted px-1 text-center text-base font-medium text-muted-foreground">
                  <span>{time}</span>
                  <span className="text-xs font-normal leading-tight">
                    {c.label}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
});
