import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import { AppointmentActions } from "@/components/appointment-actions";
import { LineageTimeline } from "@/components/lineage-timeline";
import { StaffBar } from "@/components/staff-bar";
import { StatusBadge } from "@/components/status-badge";
import { formatSlot, localDate } from "@/lib/clinic-time";
import { loadLineage } from "@/lib/dashboard-data";
import { getAppointment } from "@/lib/api";
import { can } from "@/lib/roles";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Appointment history" };
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
  const canAct =
    can(staff.role, "manage-appointments") && appt.status === "booked";

  return (
    <>
      <StaffBar
        name={staff.name}
        email={staff.email}
        image={staff.image}
        role={staff.role}
      />
      <div className="space-y-6 py-6">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronLeftIcon className="size-4" aria-hidden /> Dashboard
        </Link>
        <header className="space-y-2">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Appointment history
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-lg">
            <span className="tabular-nums">{formatSlot(appt.starts_at)}</span>
            <StatusBadge status={appt.status} />
          </p>
          {appt.cancellation_reason && (
            <p className="text-muted-foreground">
              Reason: {appt.cancellation_reason}
            </p>
          )}
        </header>

        {canAct && (
          <AppointmentActions
            appointmentId={appt.id}
            doctorId={appt.doctor_id}
            today={localDate(new Date())}
          />
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
    </>
  );
}
