import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { BookOnBehalf } from "@/components/book-on-behalf";
import { SlotsSheet } from "@/components/slots-sheet";
import { formatSlot, formatTime } from "@/lib/clinic-time";
import type { FreeSlot, GapList } from "@clinic/api/generated";

interface Run {
  doctorId: string;
  doctorName: string;
  starts_at: string;
  ends_at: string;
  slots: FreeSlot[];
}

// The API lists single free half hours; back-to-back ones for the same doctor read as one gap.
function runs(items: readonly FreeSlot[]): Run[] {
  const out: Run[] = [];
  for (const s of items) {
    const last = [...out]
      .reverse()
      .find((r) => r.doctorId === s.doctor_id && r.ends_at === s.starts_at);
    if (last) {
      last.ends_at = s.ends_at;
      last.slots.push(s);
    } else {
      out.push({
        doctorId: s.doctor_id,
        doctorName: s.doctor_name,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        slots: [s],
      });
    }
  }
  return out;
}

// Free time in the next 48 hours, soonest first. Staff can book a patient into any slot of a gap
// from here (owner and admin; the API checks again).
//
// A slot taken by a synthetic (test) booking is not free here, on purpose: that booking holds the
// slot for real, so a patient trying to book it would get SLOT_TAKEN. The list is exactly what
// can be booked (an e2e compares it with the public availability), even though synthetic visits
// are left out of the counts and the board.
export function GapsToFill({
  gaps,
  canBook,
}: {
  gaps: GapList;
  canBook: boolean;
}) {
  const all = runs(gaps.items);
  const shown = all.slice(0, 8);
  return (
    <section aria-labelledby="gaps" className="space-y-3">
      <h2
        id="gaps"
        className="font-heading text-xl font-semibold tracking-tight"
      >
        Gaps to fill
        <span className="ml-2 text-base font-normal text-muted-foreground">
          next {gaps.hours} hours
        </span>
      </h2>
      {shown.length === 0 ? (
        <p
          className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground"
          data-testid="gaps-empty"
        >
          No free time in the next {gaps.hours} hours. Every slot on offer is
          booked.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-xl border border-border bg-card/80 shadow-sm backdrop-blur-sm"
          data-testid="gaps-list"
        >
          {shown.map((g) => (
            <li
              key={`${g.doctorId}-${g.starts_at}`}
              data-testid="gap"
              className="flex min-h-14 flex-wrap items-center gap-3 px-3 py-2"
            >
              <span aria-hidden="true" className="contents">
                <DoctorAvatar
                  doctorId={g.doctorId}
                  name={g.doctorName}
                  size={36}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {g.doctorName}
                </span>
                <span className="block text-sm tabular-nums text-muted-foreground">
                  {formatSlot(g.starts_at)} to {formatTime(g.ends_at)},{" "}
                  {g.slots.length} {g.slots.length === 1 ? "slot" : "slots"}
                </span>
              </span>
              {canBook && (
                <BookOnBehalf
                  doctorId={g.doctorId}
                  doctorName={g.doctorName}
                  slots={g.slots.map((s) => s.starts_at)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {gaps.items.length > 0 && (
        <SlotsSheet
          slots={gaps.items}
          hours={gaps.hours}
          truncated={gaps.truncated}
          canBook={canBook}
        />
      )}
      {(gaps.truncated || all.length > shown.length) && (
        <p className="text-sm text-muted-foreground">
          Showing the next {shown.length} gaps
          {gaps.truncated ? "; the list itself is cut short" : ""}.
        </p>
      )}
    </section>
  );
}
