"use client";

import Link from "next/link";
import {
  useCallback,
  useRef,
  useState,
  useTransition,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LockIcon } from "lucide-react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@clinic/ui/components/ui/sheet";
import { Skeleton } from "@clinic/ui/components/ui/skeleton";
import { AppointmentActions } from "@/components/appointment-actions";
import { AttendanceActions } from "@/components/attendance-actions";
import { LineageTimeline } from "@/components/lineage-timeline";
import { StaffControls } from "@/components/staff-controls";
import { StatusBadge } from "@/components/status-badge";
import { inAttendanceWindow, isStillToCome } from "@/lib/attendance-window";
import { formatSlot, localDate } from "@/lib/clinic-time";
import type { AppointmentDetail, DetailResult } from "@/lib/detail-read";
import { ZoneNote } from "@clinic/ui/components/zone-note";
import { shownName } from "@/lib/shown-name";
import { canVeto } from "@/lib/veto";

const ACTION: Record<string, string> = {
  book: "Booked for the patient",
  reschedule: "Moved",
  cancel: "Cancelled",
  veto: "Undid a patient change and locked",
  unlock: "Unlocked",
  arrived: "Marked arrived",
  no_show: "Marked no-show",
  reminder_now: "Sent a reminder",
  running_late: "Told the patient the doctor is running late",
};

/**
 * A link to an appointment that opens its detail in a sheet instead of leaving the page. It is a real
 * anchor: a click with a modifier key, a middle click and "open in a new tab" still go to the full
 * page, and with no script it is just the link. Everyone who can see the dashboard can open it; the
 * sheet shows what the API gives that person, and the actions only to owner and admin.
 */
export function AppointmentLink({
  id,
  canAct,
  className,
  children,
  ...rest
}: {
  id: string;
  /** Owner and admin: the sheet carries the actions. The server checks again on every one. */
  canAct: boolean;
  className?: string;
  children: ReactNode;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const anchor = useRef<HTMLAnchorElement>(null);

  const read = useCallback(() => {
    start(async () => {
      let res: DetailResult;
      try {
        res = (await (
          await fetch(`/dashboard/read/appointment/${id}`, {
            cache: "no-store",
          })
        ).json()) as DetailResult;
      } catch {
        res = {
          ok: false,
          message: "The clinic service did not answer. Try again.",
        };
      }
      if (res.ok) {
        setDetail(res.detail);
        setError(null);
      } else {
        setError(res.message);
      }
    });
  }, [id]);

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    setDetail(null);
    setError(null);
    setOpen(true);
    read();
  }

  return (
    <>
      <a
        ref={anchor}
        href={`/dashboard/appointments/${id}`}
        className={className}
        onClick={onClick}
        aria-haspopup="dialog"
        {...rest}
      >
        {children}
      </a>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-h-[88dvh] w-full gap-3 overflow-y-auto rounded-t-2xl p-0 sm:max-w-3xl"
          // Focus goes back to the row that was opened, as it does for every other sheet.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            anchor.current?.focus();
          }}
        >
          <Body
            id={id}
            detail={detail}
            error={error}
            canAct={canAct}
            reload={read}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function Body({
  id,
  detail: d,
  error,
  canAct,
  reload,
}: {
  id: string;
  detail: AppointmentDetail | null;
  error: string | null;
  canAct: boolean;
  reload: () => void;
}) {
  if (error) {
    return (
      <SheetHeader className="px-4 pt-4 pr-12">
        <SheetTitle>Appointment</SheetTitle>
        <SheetDescription role="alert">{error}</SheetDescription>
        <Button variant="outline" className="min-h-11 w-fit" onClick={reload}>
          Try again
        </Button>
      </SheetHeader>
    );
  }
  if (!d) {
    return (
      <>
        <SheetHeader className="px-4 pt-4 pr-12">
          <SheetTitle>Appointment</SheetTitle>
          <SheetDescription>Loading the appointment.</SheetDescription>
        </SheetHeader>
        <div className="space-y-2 px-4 pb-4" aria-hidden="true">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </>
    );
  }
  const name = d.patientName ? shownName(d.patientName, d.view) : "Appointment";
  const mark = d.status === "booked" ? (d.attendance ?? "booked") : null;
  const mayMark =
    canAct && mark !== null && inAttendanceWindow(d.startsAt, d.nowMs);
  const mayChange =
    canAct && d.status === "booked" && isStillToCome(d.startsAt, d.nowMs);
  const veto = canVeto(d.events, d.status, d.locked);
  const hidden = d.view === "minimised";
  // Anything that normally comes with a reason, and so is worth saying is hidden from this role.
  const hasStaffAction =
    d.locked ||
    d.attendance !== null ||
    d.events.some((e) => e.actor === "staff");

  return (
    <>
      <SheetHeader className="px-4 pt-4 pr-12">
        <SheetTitle
          className="font-heading text-xl"
          data-testid="sheet-patient"
        >
          {name}
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-2 tabular-nums">
          <span>{formatSlot(d.startsAt)}</span>
          <StatusBadge status={d.status} attendance={d.attendance} />
          {d.doctorName && (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="contents">
                <DoctorAvatar
                  doctorId={d.doctorId}
                  name={d.doctorName}
                  size={24}
                />
              </span>
              {d.doctorName}
            </span>
          )}
        </SheetDescription>
        <ZoneNote />
      </SheetHeader>

      <div className="space-y-5 px-4 pb-5">
        {d.locked && (
          <p
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
            data-testid="sheet-locked"
          >
            <LockIcon className="size-4" aria-hidden /> Locked by staff. The
            patient cannot change this appointment.
          </p>
        )}

        <section
          aria-labelledby={`reason-${id}`}
          className="space-y-1"
          data-testid="sheet-reasons"
        >
          <h3 id={`reason-${id}`} className="font-medium">
            Reasons on record
          </h3>
          {d.cancellationReason && (
            <p className="text-sm">Cancellation: {d.cancellationReason}</p>
          )}
          {d.audit && d.audit.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {d.audit.map((a) => (
                <li key={a.id}>
                  {ACTION[a.action] ?? a.action}: {a.reason}{" "}
                  <span className="text-muted-foreground">
                    ({a.actor_email}, {formatSlot(a.occurred_at)})
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {!d.cancellationReason && !(d.audit && d.audit.length > 0) && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="sheet-reason-note"
            >
              {hidden && (d.status === "cancelled" || hasStaffAction)
                ? "Reason on record: hidden for your role."
                : "No reason is on record for this appointment."}
            </p>
          )}
          {hidden && d.cancellationReason === null && d.status === "cancelled"
            ? null
            : null}
        </section>

        {canAct && (mayMark || mayChange || d.locked || veto) && (
          <section
            aria-labelledby={`actions-${id}`}
            className="space-y-3"
            data-testid="sheet-actions"
          >
            <h3 id={`actions-${id}`} className="font-medium">
              Actions
            </h3>
            <div className="flex flex-wrap gap-3">
              {mayMark && mark && (
                <AttendanceActions
                  appointmentId={d.id}
                  mark={mark}
                  onDone={reload}
                />
              )}
              {mayChange && (
                <AppointmentActions
                  appointmentId={d.id}
                  doctorId={d.doctorId}
                  today={localDate(new Date(d.nowMs))}
                  onDone={reload}
                />
              )}
              <StaffControls
                appointmentId={d.id}
                locked={d.locked}
                canVeto={veto}
                onDone={reload}
              />
            </div>
          </section>
        )}

        <section aria-labelledby={`history-${id}`}>
          <h3 id={`history-${id}`} className="mb-3 font-medium">
            What happened
          </h3>
          <LineageTimeline events={d.events} />
        </section>

        <p>
          <Link
            href={`/dashboard/appointments/${d.id}`}
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          >
            Open the full page
          </Link>
        </p>
      </div>
    </>
  );
}
