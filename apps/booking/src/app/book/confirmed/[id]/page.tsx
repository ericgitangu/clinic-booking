import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@clinic/ui/components/ui/button";
import { ToastOnMount } from "@/components/booking/toast-on-mount";
import * as api from "@/lib/api";
import { formatWhen } from "@/lib/clinic-time";

export const metadata: Metadata = { title: "Booked", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function Confirmed({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const appt = await api.getAppointment(id);
  if (!appt.ok) {
    if (appt.status < 500) notFound();
    return (
      <p role="alert" className="py-10 text-base">
        We could not load your booking just now. Reload the page in a moment.
      </p>
    );
  }
  const doctor = await api.getDoctor(appt.data.doctor_id);
  return (
    <section className="py-10">
      <ToastOnMount message="Appointment booked." />
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        You are booked
      </h1>
      <div className="mt-6 rounded-xl border border-border bg-card p-5">
        <p className="text-xl font-semibold">
          {formatWhen(appt.data.starts_at)}
        </p>
        {doctor.ok ? (
          <p className="mt-1 text-base text-muted-foreground">
            {doctor.data.full_name}, {doctor.data.specialty}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          Nairobi time, 30 minutes.
        </p>
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Button asChild size="lg" className="h-12 px-6 text-base">
          <Link href="/appointments">My appointments</Link>
        </Button>
        <Button
          asChild
          size="lg"
          variant="outline"
          className="h-12 px-6 text-base"
        >
          <Link href="/book">Book another</Link>
        </Button>
      </div>
    </section>
  );
}
