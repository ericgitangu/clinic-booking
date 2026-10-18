import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { SignInPrompt } from "@/components/account/sign-in-prompt";
import { AppointmentActions } from "@/components/booking/appointment-actions";
import { ToastOnMount } from "@/components/booking/toast-on-mount";
import * as api from "@/lib/api";
import { formatWhen } from "@/lib/clinic-time";
import { callerFor, getIdentity } from "@/lib/session";

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
  const who = await getIdentity();

  if (!who) {
    return (
      <SignInPrompt
        title="My appointments"
        body="Sign in with the Google account you book with to see, move or cancel your appointments."
        returnTo="/appointments"
      />
    );
  }

  const res = await api.myAppointments(callerFor(who));
  // Someone who has never booked has no patient record yet: that is an empty list, not an error.
  const never =
    !res.ok && res.kind === "problem" && res.code === "PATIENT_NOT_FOUND";
  const upcoming = res.ok
    ? res.data.items.filter((a) => a.status === "booked")
    : [];

  return (
    <section className="py-10">
      {rescheduled ? <ToastOnMount message="Appointment moved." /> : null}
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        My appointments
      </h1>
      <p className="mt-2 text-base text-muted-foreground">
        Signed in as {who.name}.
      </p>

      {!res.ok && !never ? (
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
                  <Link
                    href={`/appointments/${a.id}`}
                    className="flex items-start gap-4 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                  >
                    <span aria-hidden="true">
                      <DoctorAvatar
                        doctorId={a.doctor_id}
                        name={a.doctor.full_name}
                        size={48}
                      />
                    </span>
                    <span>
                      <span className="block text-lg font-semibold underline-offset-4 hover:underline">
                        {formatWhen(a.starts_at)}
                      </span>
                      <span className="mt-1 block text-base text-muted-foreground">
                        {a.doctor.full_name}, {a.doctor.specialty}
                      </span>
                    </span>
                  </Link>
                  <AppointmentActions
                    id={a.id}
                    when={formatWhen(a.starts_at)}
                    startsAt={a.starts_at}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <div className="mt-10">
        <Button asChild size="lg" className="h-12 px-6 text-base">
          <Link href="/book">Book a visit</Link>
        </Button>
      </div>
    </section>
  );
}
