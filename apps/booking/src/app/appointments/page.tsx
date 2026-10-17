import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { clearRememberedPatient } from "@/app/actions";
import { AppointmentActions } from "@/components/booking/appointment-actions";
import { ToastOnMount } from "@/components/booking/toast-on-mount";
import * as api from "@/lib/api";
import { formatWhen } from "@/lib/clinic-time";
import { readPatient } from "@/lib/patient-cookie";

export const metadata: Metadata = {
  title: "My appointments",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function MyAppointments({
  searchParams,
}: {
  searchParams: Promise<{ rescheduled?: string }>;
}) {
  const { rescheduled } = await searchParams;
  const patient = await readPatient();

  if (!patient) {
    return (
      <section className="py-10">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          My appointments
        </h1>
        <p className="mt-4 max-w-[60ch] text-lg leading-8 text-muted-foreground">
          You have not booked from this browser yet. Once you do, your
          appointments show up here.
        </p>
        <Button asChild size="lg" className="mt-8 h-12 px-6 text-base">
          <Link href="/book">Book a visit</Link>
        </Button>
      </section>
    );
  }

  const res = await api.listPatientAppointments(patient.id);
  const now = Date.now();
  const items = res.ok ? res.data.items : [];
  const upcoming = items.filter(
    (a) => a.status === "booked" && Date.parse(a.starts_at) > now,
  );

  return (
    <section className="py-10">
      {rescheduled ? <ToastOnMount message="Appointment moved." /> : null}
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        My appointments
      </h1>
      <p className="mt-2 text-base text-muted-foreground">
        Booked as {patient.name}.
      </p>

      {!res.ok ? (
        <p
          role="alert"
          className="mt-8 rounded-lg border border-border bg-muted p-4 text-base"
        >
          We could not load your appointments just now. Reload the page in a
          moment.
        </p>
      ) : (
        <>
          <h2 className="mt-8 font-heading text-xl font-semibold">Upcoming</h2>
          {upcoming.length === 0 ? (
            <p className="mt-3 text-base text-muted-foreground">
              Nothing booked.
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {upcoming.map((a) => (
                <li
                  key={a.id}
                  className="rounded-xl border border-border bg-card p-5"
                >
                  <p className="text-lg font-semibold">
                    {formatWhen(a.starts_at)}
                  </p>
                  <p className="mt-1 text-base text-muted-foreground">
                    {a.doctor.full_name}, {a.doctor.specialty}
                  </p>
                  <AppointmentActions
                    id={a.id}
                    when={formatWhen(a.starts_at)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Button asChild size="lg" className="h-12 px-6 text-base">
          <Link href="/book">Book a visit</Link>
        </Button>
        <form action={clearRememberedPatient}>
          <Button type="submit" variant="ghost" className="h-11 text-base">
            Not {patient.name}? Forget me on this device
          </Button>
        </form>
      </div>
    </section>
  );
}
