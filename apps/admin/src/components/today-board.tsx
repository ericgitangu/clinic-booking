import Link from "next/link";
import {
  ClockAlertIcon,
  DownloadIcon,
  LockIcon,
  PrinterIcon,
} from "lucide-react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Button } from "@clinic/ui/components/ui/button";
import { AppointmentActions } from "@/components/appointment-actions";
import { AttendanceActions } from "@/components/attendance-actions";
import { DrillSheet } from "@/components/drill-sheet";
import { StaffControls } from "@/components/staff-controls";
import { StatusBadge } from "@/components/status-badge";
import { inAttendanceWindow, isStillToCome } from "@/lib/attendance-window";
import { CLINIC_TZ, addDays, formatSlot, formatTime } from "@/lib/clinic-time";
import { shownName } from "@/lib/shown-name";
import type { TodayBoard as Board } from "@clinic/api/generated";

// Today for every doctor, in time order: each visit with its status (booked, arrived, no-show,
// cancelled), the next free gap, and a flag when the desk is running behind. Everything on it is the
// API's read model; the names are as the API chose to show them for this role.
export function TodayBoard({
  board,
  date,
  now,
  canAct,
  canExport,
}: {
  board: Board;
  date: string;
  now: Date;
  /** Owner and admin: mark attendance, cancel or move a visit. The server checks again. */
  canAct: boolean;
  /** Owner and admin: day-sheet CSV and the print view. */
  canExport: boolean;
}) {
  const nowMs = now.getTime();
  const totals = board.totals;
  return (
    <section aria-labelledby="today" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="today"
          className="font-heading text-xl font-semibold tracking-tight"
        >
          Today
          <span className="ml-2 text-base font-normal text-muted-foreground">
            {new Intl.DateTimeFormat("en-GB", {
              timeZone: CLINIC_TZ,
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(new Date(`${date}T12:00:00Z`))}
          </span>
        </h2>
        {canExport && (
          <div className="flex gap-2">
            <Button asChild variant="outline" className="min-h-11">
              <a href={`/dashboard/day-sheet?date=${date}`} download>
                <DownloadIcon aria-hidden /> Day sheet (CSV)
              </a>
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/dashboard/print">
                <PrinterIcon aria-hidden /> Print
              </Link>
            </Button>
          </div>
        )}
      </div>
      {/* Each figure opens the visits behind it. Read together the line is still
          "X booked, Y arrived, Z no-show, W cancelled." */}
      <p className="text-sm text-muted-foreground" data-testid="today-totals">
        {(
          [
            ["booked", "booked", totals.booked, "Booked, not yet marked"],
            ["arrived", "arrived", totals.arrived, "Arrived"],
            ["no_show", "no-show", totals.no_show, "No-show"],
            ["cancelled", "cancelled", totals.cancelled, "Cancelled"],
          ] as const
        ).map(([visit, word, n, title], i, all) => (
          <span key={visit}>
            <DrillSheet
              className="inline-flex min-h-6 items-center rounded-sm px-0.5 underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              config={{
                title: `${title} today`,
                description: "Visits today, all doctors.",
                spec: { from: date, to: addDays(date, 1), status: "all" },
                visit,
                expected: n,
              }}
            >
              {n} {word}
            </DrillSheet>
            {i < all.length - 1 ? ", " : "."}
          </span>
        ))}
      </p>
      {board.doctors.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          No doctors are set up yet. Add one and their day shows here.
        </p>
      ) : (
        <ul
          className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2"
          data-testid="today-board"
        >
          {board.doctors.map((d) => {
            const booked = d.appointments.filter(
              (a) => a.status === "booked",
            ).length;
            return (
              <li
                key={d.doctor_id}
                data-testid={`today-${d.doctor_id}`}
                className="min-w-0 rounded-xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur-sm"
              >
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="contents">
                    <DoctorAvatar
                      doctorId={d.doctor_id}
                      name={d.name}
                      size={44}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{d.name}</h3>
                    <p className="truncate text-sm text-muted-foreground">
                      {d.specialty}
                    </p>
                  </div>
                  <p
                    className="text-right text-sm tabular-nums"
                    data-testid="today-summary"
                  >
                    <span className="block font-medium">{booked} booked</span>
                    <span className="block text-muted-foreground">
                      {d.next_gap
                        ? `Next free ${formatTime(d.next_gap.starts_at)}`
                        : "Nothing free"}
                    </span>
                  </p>
                </div>
                {d.appointments.length > 0 && (
                  <div className="mt-2 flex justify-end">
                    <DrillSheet
                      className="inline-flex min-h-11 items-center rounded-md px-2 text-sm underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      config={{
                        title: `${d.name}, today`,
                        description:
                          "Every visit today with this doctor, any status.",
                        spec: {
                          from: date,
                          to: addDays(date, 1),
                          status: "all",
                          doctorId: d.doctor_id,
                        },
                      }}
                    >
                      <span data-testid="today-drill">
                        See all {d.appointments.length}{" "}
                        {d.appointments.length === 1 ? "visit" : "visits"}
                      </span>
                    </DrillSheet>
                  </div>
                )}
                {d.running_behind.behind && (
                  <p
                    className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-medium"
                    data-testid="running-behind"
                  >
                    <ClockAlertIcon className="size-4 shrink-0" aria-hidden />
                    Running behind: the first visit not yet marked began{" "}
                    {d.running_behind.minutes} min ago.
                  </p>
                )}
                {d.appointments.length === 0 ? (
                  <p className="mt-3 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                    No visits today.
                  </p>
                ) : (
                  <ol className="mt-3 divide-y divide-border">
                    {d.appointments.map((a) => {
                      const future = isStillToCome(a.starts_at, nowMs);
                      const mayMark =
                        canAct &&
                        a.status !== "cancelled" &&
                        inAttendanceWindow(a.starts_at, nowMs);
                      const mayChange =
                        canAct && a.status === "booked" && future;
                      return (
                        <li key={a.id} data-testid="today-visit">
                          <Link
                            href={`/dashboard/appointments/${a.id}`}
                            data-row-link
                            data-row-label={`${shownName(a.patient_name, board.view)}, ${formatSlot(a.starts_at)}, ${a.status}`}
                            className="flex min-h-11 items-center gap-3 rounded-md py-2 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          >
                            <span className="w-12 shrink-0 text-sm tabular-nums">
                              {formatTime(a.starts_at)}
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                              {shownName(a.patient_name, board.view)}
                              {a.locked && (
                                <LockIcon
                                  className="ml-1.5 inline size-3.5 text-muted-foreground"
                                  aria-label="Locked by staff"
                                />
                              )}
                            </span>
                            <StatusBadge status={a.status} />
                          </Link>
                          {canAct && (
                            <div className="flex flex-wrap gap-2 pb-2 sm:pl-14">
                              {mayMark && (
                                <AttendanceActions
                                  appointmentId={a.id}
                                  mark={
                                    a.status as "booked" | "arrived" | "no_show"
                                  }
                                />
                              )}
                              {mayChange && (
                                <AppointmentActions
                                  compact
                                  appointmentId={a.id}
                                  doctorId={d.doctor_id}
                                  today={date}
                                />
                              )}
                              {/* Only Unlock here: whether a patient change is waiting to be undone is
                                  known on the appointment page, not in the board's data. */}
                              {a.locked && (
                                <StaffControls
                                  appointmentId={a.id}
                                  locked
                                  canVeto={false}
                                  compact
                                />
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
