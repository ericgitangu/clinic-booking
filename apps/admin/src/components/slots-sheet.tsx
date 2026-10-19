"use client";

import { useMemo, useState } from "react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Label } from "@clinic/ui/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@clinic/ui/components/ui/sheet";
import { BookOnBehalf } from "@/components/book-on-behalf";
import { formatSlot } from "@/lib/clinic-time";

export interface SlotRow {
  doctor_id: string;
  doctor_name: string;
  starts_at: string;
  ends_at: string;
}

// Every free half hour in the window, one by one, for one doctor or all. Opened from the gaps
// section; the count above the list is the number of slots the API returned, and says when the API
// cut its own list short. Owner and admin can book into any slot from here.
export function SlotsSheet({
  slots,
  hours,
  truncated,
  canBook,
  title = "Free slots",
  children,
  triggerClassName,
}: {
  slots: readonly SlotRow[];
  hours: number;
  /** The API's own cut. */
  truncated: boolean;
  canBook: boolean;
  title?: string;
  /** What the trigger shows; without it the trigger reads "See all N free slots". */
  children?: React.ReactNode;
  triggerClassName?: string;
}) {
  const [doctorId, setDoctorId] = useState("");
  const doctors = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of slots) m.set(s.doctor_id, s.doctor_name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  }, [slots]);
  const rows = doctorId ? slots.filter((s) => s.doctor_id === doctorId) : slots;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          className={
            triggerClassName ??
            "inline-flex min-h-11 items-center rounded-md px-1 text-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          }
          data-testid={children ? "gap-open" : "slots-open"}
        >
          {children ?? (
            <>
              See all {slots.length} free{" "}
              {slots.length === 1 ? "slot" : "slots"}
            </>
          )}
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[88dvh] w-full gap-3 overflow-hidden rounded-t-2xl p-0 sm:max-w-3xl"
      >
        <SheetHeader className="px-4 pt-4 pr-12">
          <SheetTitle className="font-heading text-lg">{title}</SheetTitle>
          <SheetDescription>
            Free half hours
            {children ? " in this gap" : ` in the next ${hours} hours`}, soonest
            first.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-1 px-4">
          <Label htmlFor="slots-doctor">Doctor</Label>
          <select
            id="slots-doctor"
            value={doctorId}
            onChange={(e) => setDoctorId(e.target.value)}
            className="min-h-11 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-64"
          >
            <option value="">All doctors</option>
            {doctors.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <p
          className="px-4 text-sm font-medium tabular-nums"
          role="status"
          aria-live="polite"
          data-testid="slots-count"
          data-count={rows.length}
        >
          {rows.length} {rows.length === 1 ? "slot" : "slots"}
          {truncated && !doctorId
            ? ". The list is cut short by the service; this is the soonest part of it."
            : ""}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
              No free slots for this choice.
            </p>
          ) : (
            <ul
              className="divide-y divide-border rounded-lg border border-border"
              data-testid="slots-list"
            >
              {rows.map((s) => (
                <li
                  key={`${s.doctor_id}-${s.starts_at}`}
                  className="flex min-h-14 flex-wrap items-center gap-3 px-3 py-2"
                >
                  <span aria-hidden="true" className="contents">
                    <DoctorAvatar
                      doctorId={s.doctor_id}
                      name={s.doctor_name}
                      size={32}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {s.doctor_name}
                    </span>
                    <span className="block text-sm tabular-nums text-muted-foreground">
                      {formatSlot(s.starts_at)}
                    </span>
                  </span>
                  {canBook && (
                    <BookOnBehalf
                      doctorId={s.doctor_id}
                      doctorName={s.doctor_name}
                      slots={[s.starts_at]}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
