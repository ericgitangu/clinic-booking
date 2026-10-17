import Link from "next/link";
import { clinicDay, formatDayShort, formatTime } from "@/lib/clinic-time";
import type { NextSlot } from "@/lib/action-state";

// Shown when the chosen time was taken: the next free times, each one a tap away.
export function NextSlots({
  slots,
  hrefFor,
}: {
  slots: NextSlot[];
  hrefFor: (startsAt: string) => string;
}) {
  if (slots.length === 0) {
    return (
      <p className="text-base">
        No other free times in the next few days. Try another date.
      </p>
    );
  }
  return (
    <div>
      <p className="text-base font-medium">Here are the next free times:</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {slots.map((s) => {
          const d = formatDayShort(clinicDay(s.starts_at));
          return (
            <li key={s.starts_at}>
              <Link
                href={hrefFor(s.starts_at)}
                className="flex min-h-12 flex-col items-center justify-center rounded-lg border border-border bg-card px-2 text-center hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="text-sm text-muted-foreground">
                  {d.weekday} {d.date}
                </span>
                <span className="text-base font-semibold">
                  {formatTime(s.starts_at)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
