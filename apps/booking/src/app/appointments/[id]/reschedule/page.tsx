import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateStrip } from "@/components/booking/date-strip";
import { SlotChooser } from "@/components/booking/slot-chooser";
import * as api from "@/lib/api";
import {
  clinicDay,
  formatDayLong,
  formatWhen,
  isValidDay,
} from "@/lib/clinic-time";
import { readPatient } from "@/lib/patient-cookie";

export const metadata: Metadata = {
  title: "Reschedule",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function Reschedule({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const { date } = await searchParams;
  const patient = await readPatient();
  const appt = await api.getAppointment(id);
  if (!patient || !appt.ok || appt.data.patient_id !== patient.id) notFound();

  if (appt.data.status === "cancelled") {
    return (
      <section className="py-10">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Reschedule
        </h1>
        <p className="mt-4 text-base">
          This appointment is cancelled.{" "}
          <Link href="/book" className="underline underline-offset-4">
            Book a new one
          </Link>
          .
        </p>
      </section>
    );
  }

  const today = clinicDay(new Date());
  const day = isValidDay(date)
    ? date
    : clinicDay(appt.data.starts_at) >= today
      ? clinicDay(appt.data.starts_at)
      : today;
  const avail = await api.getAvailability(appt.data.doctor_id, day);

  return (
    <section className="pb-28 pt-8">
      <p className="text-base">
        <Link href="/appointments" className="underline underline-offset-4">
          My appointments
        </Link>
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight">
        Reschedule
      </h1>
      <p className="mt-1 text-base text-muted-foreground">
        Now: {formatWhen(appt.data.starts_at)}. Nairobi time.
      </p>
      <div className="mt-6">
        <DateStrip
          today={today}
          selected={day}
          basePath={`/appointments/${id}/reschedule`}
        />
      </div>
      <h2 className="mt-8 font-heading text-xl font-semibold">
        {formatDayLong(day)}
      </h2>
      <div className="mt-4">
        {avail.ok ? (
          <SlotChooser
            mode="reschedule"
            appointmentId={id}
            slots={avail.data.slots}
          />
        ) : (
          <p
            role="alert"
            className="rounded-lg border border-border bg-muted p-4 text-base"
          >
            We could not load the free times. Reload the page in a moment.
          </p>
        )}
      </div>
    </section>
  );
}
