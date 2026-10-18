import { memo } from "react";
import { formatTime } from "@/lib/clinic-time";
import type { Chip } from "@/lib/slot-chips";

// The time grid. A free time is a radio. Every other time stays on the grid, in place, as a
// disabled radio (so it can be neither chosen nor focused, and a screen reader says it is
// unavailable) with the reason written under the time. Nothing here decides which state a time is
// in; lib/slot-chips.ts does, so this stays a plain function of its props and can be memoised.
export const SlotRadios = memo(function SlotRadios({
  chips,
  value,
  onChange,
}: {
  chips: readonly Chip[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      <legend className="sr-only">Times</legend>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {chips.map((c) => {
          const free = c.state === "free";
          return (
            <li key={c.starts_at} data-state={c.state}>
              <label className="block">
                <input
                  type="radio"
                  name="slot"
                  value={c.starts_at}
                  checked={free && value === c.starts_at}
                  onChange={() => onChange(c.starts_at)}
                  disabled={!free}
                  aria-disabled={free ? undefined : true}
                  className="peer sr-only"
                />
                <span
                  className={
                    "slot-chip-label flex min-h-14 flex-col items-center justify-center rounded-lg border px-1 text-center motion-safe:transition-colors " +
                    (free
                      ? "cursor-pointer border-border bg-card text-base font-semibold hover:bg-accent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:hover:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring"
                      : "cursor-not-allowed border-dashed border-muted-foreground/50 bg-muted text-base font-medium text-muted-foreground")
                  }
                >
                  <span>{formatTime(c.starts_at)}</span>
                  {c.label ? (
                    <span className="text-xs font-normal leading-tight">
                      {c.label}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
});
