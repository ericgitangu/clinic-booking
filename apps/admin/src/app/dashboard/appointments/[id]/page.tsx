import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { LockedNote, StaffControls } from "@/components/staff-controls";
import { AttendanceActions } from "@/components/attendance-actions";
import { AppointmentActions } from "@/components/appointment-actions";
import { AppointmentLive } from "@/components/appointment-live";
import { LineageTimeline } from "@/components/lineage-timeline";
import { StatusBadge } from "@/components/status-badge";
import { formatSlot, localDate } from "@/lib/clinic-time";
import { loadAppointmentRow, loadLineage } from "@/lib/dashboard-data";
import { getAppointment } from "@/lib/api";
import { shownName } from "@/lib/shown-name";
import { inAttendanceWindow, isStillToCome } from "@/lib/attendance-window";
import { can } from "@/lib/roles";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Appointment" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requireStaff("view");
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [lineage, current] = await Promise.all([
    loadLineage(staff, id),
    getAppointment(id),
  ]);
  if (!lineage.found || (!current.ok && current.status === 404)) notFound();
  if (!current.ok) throw new Error(`appointment failed (${current.status})`);
  const appt = current.data;
  // Names are not in the public read, so they come from the admin list; without them the page
  // still shows the visit, by time and status.
  const row = await loadAppointmentRow(staff, appt);
  const canStaff = can(staff.role, "manage-appointments");
  const nowMs = Date.now();
  // Cancel and move only before the visit starts; the API refuses anything else.
  const canAct =
    canStaff &&
    appt.status === "booked" &&
    isStillToCome(appt.starts_at, nowMs);
  // Arrived or no-show, in the desk window, for a visit that has not been cancelled.
  const mark =
    row && appt.status === "booked" ? (row.attendance ?? "booked") : null;
  const canMark =
    canStaff && mark !== null && inAttendanceWindow(appt.starts_at, nowMs);

  return (
    <div className="space-y-6 py-6">
      <Link
        href="/dashboard"
        className="inline-flex min-h-11 items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronLeftIcon className="size-4" aria-hidden /> Dashboard
      </Link>
      <header className="space-y-3">
        <h1
          className="font-heading text-3xl font-semibold tracking-tight"
          data-testid="appointment-patient"
        >
          {row ? shownName(row.patient_name, row.view) : "Appointment"}
        </h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-lg">
          <span className="tabular-nums">{formatSlot(appt.starts_at)}</span>
          <StatusBadge status={appt.status} attendance={row?.attendance} />
        </p>
        {row && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <span aria-hidden="true" className="contents">
              <DoctorAvatar
                doctorId={row.doctor_id}
                name={row.doctor_name}
                size={32}
              />
            </span>
            <span>{row.doctor_name}</span>
          </p>
        )}
        {/* The reason comes from the admin read, which the API minimises by role; the public read of
            the same appointment carries it in full and must not be used for this. */}
        {row?.cancellation_reason && (
          <p className="text-muted-foreground">
            Reason: {row.cancellation_reason}
          </p>
        )}
        {staff.role && (
          <AppointmentLive appointmentId={appt.id} role={staff.role} />
        )}
      </header>

      {row?.staff_locked && <LockedNote />}

      {canStaff && (
        <section
          aria-labelledby="actions"
          className="space-y-3"
          data-testid="staff-actions"
        >
          <h2
            id="actions"
            className="font-heading text-xl font-semibold tracking-tight"
          >
            Actions
          </h2>
          <div className="flex flex-wrap gap-3">
            {canMark && mark && (
              <AttendanceActions appointmentId={appt.id} mark={mark} />
            )}
            {canAct && (
              <AppointmentActions
                appointmentId={appt.id}
                doctorId={appt.doctor_id}
                today={localDate(new Date())}
              />
            )}
            <StaffControls
              appointmentId={appt.id}
              locked={row?.staff_locked ?? false}
            />
          </div>
        </section>
      )}

      <section aria-labelledby="path" className="max-w-xl">
        <h2
          id="path"
          className="mb-5 font-heading text-xl font-semibold tracking-tight"
        >
          What happened
        </h2>
        <LineageTimeline events={lineage.events} />
      </section>
    </div>
  );
}
