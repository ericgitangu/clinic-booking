import { ArrowRightIcon } from "lucide-react";
import { formatSlot } from "@/lib/clinic-time";
import type { LineageEvent } from "@clinic/api/generated";

const TITLE: Record<LineageEvent["event_type"], string> = {
  booked: "Booked",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

// Each marker differs in shape and colour, so the path reads without relying on hue alone.
const MARK: Record<LineageEvent["event_type"], string> = {
  booked: "rounded-full bg-chart-1",
  rescheduled: "rotate-45 rounded-[3px] bg-chart-3",
  cancelled: "rounded-sm bg-destructive",
};

function slotLine(e: LineageEvent) {
  if (e.event_type === "rescheduled" && e.from_starts_at && e.to_starts_at) {
    return (
      <span className="flex flex-wrap items-center gap-x-2 tabular-nums">
        <span className="text-muted-foreground line-through">
          {formatSlot(e.from_starts_at)}
        </span>
        <ArrowRightIcon className="size-4" aria-label="moved to" />
        <span>{formatSlot(e.to_starts_at)}</span>
      </span>
    );
  }
  const slot = e.to_starts_at ?? e.from_starts_at;
  return slot ? (
    <span className="tabular-nums">Visit {formatSlot(slot)}</span>
  ) : null;
}

// The history of one appointment, oldest first, read from the event log. The rail is the order
// things happened in; the time under each title is when the action was taken.
export function LineageTimeline({
  events,
}: {
  events: readonly LineageEvent[];
}) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground">
        No history was recorded for this appointment.
      </p>
    );
  }
  return (
    <ol
      className="relative ml-2.5 border-l-2 border-border"
      data-testid="lineage"
    >
      {events.map((e, i) => (
        <li
          key={e.id}
          className="relative pb-7 pl-8 last:pb-0"
          data-testid={`lineage-${e.event_type}`}
        >
          <span
            aria-hidden
            className={`absolute top-1.5 -left-[11px] block size-5 ring-4 ring-background ${MARK[e.event_type]}`}
          />
          <p className="font-heading text-lg font-semibold leading-tight">
            {TITLE[e.event_type]}
            {i === events.length - 1 && events.length > 1 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                latest
              </span>
            )}
          </p>
          <p className="mt-0.5">{slotLine(e)}</p>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            Done {formatSlot(e.occurred_at)}
          </p>
        </li>
      ))}
    </ol>
  );
}
