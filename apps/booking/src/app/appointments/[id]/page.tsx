import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@clinic/ui/components/ui/button";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { SignInPrompt } from "@/components/account/sign-in-prompt";
import { AppointmentActions } from "@/components/booking/appointment-actions";
import * as api from "@/lib/api";
import { clinicDay, formatWhen } from "@/lib/clinic-time";
import { callerFor, getIdentity } from "@/lib/session";

export const metadata: Metadata = {
  title: "Appointment",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

export default async function AppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const who = await getIdentity();
  if (!who) {
    return (
      <SignInPrompt
        title="Sign in to see your appointment"
        body="Appointments belong to the Google account that booked them, so only you can see or change them."
        returnTo={`/appointments/${id}`}
      />
    );
  }
  // 404 for an appointment that is not this person's, the same as for one that does not exist.
  const res = await api.myAppointment(callerFor(who), id);
  if (!res.ok) {
    // The API refusing the session is a sign-in question, not a missing page.
    if (res.status === 401 || res.status === 403) {
      return (
        <SignInPrompt
          title="Sign in to see your appointment"
          body="Your session has ended. Sign in again with the Google account that booked."
          returnTo={`/appointments/${id}`}
        />
      );
    }
    if (res.status < 500) notFound();
    return (
      <p role="alert" className="py-10 text-base">
        We could not load this appointment just now. Reload the page in a
        moment.
      </p>
    );
  }
  const a = res.data;
  const doc = await api.getDoctor(a.doctor_id);
  const doctorName = doc.ok ? doc.data.full_name : "Your doctor";
  const when = formatWhen(a.starts_at);
  const cancelled = a.status === "cancelled";
  const future = Date.parse(a.starts_at) > Date.now();
  // A booked visit whose time has gone is history: no way to move or cancel it.
  const passed = !cancelled && !future;

  return (
    <section className="py-10">
      <p className="text-base">
        <Link href="/appointments" className="underline underline-offset-4">
          My appointments
        </Link>
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        {cancelled
          ? "Appointment cancelled"
          : passed
            ? "This visit has passed"
            : "Your appointment"}
      </h1>
      <div
        data-testid="appointment-card"
        data-status={a.status}
        className="mt-6 flex items-start gap-4 rounded-xl border border-border bg-card p-5"
      >
        <DoctorAvatar doctorId={a.doctor_id} name={doctorName} size={56} />
        <div>
          <p className="text-xl font-semibold">{when}</p>
          <p className="mt-1 text-base text-muted-foreground">
            {doc.ok
              ? `${doc.data.full_name}, ${doc.data.specialty}`
              : doctorName}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Nairobi time, 30 minutes.
          </p>
        </div>
      </div>
      {cancelled ? (
        <div data-testid="cancelled-note" className="mt-6 space-y-3 text-base">
          <p>
            {future
              ? `This appointment was cancelled. ${when} is free again, and anyone can book it.`
              : "This appointment was cancelled."}
          </p>
          {a.cancellation_reason ? (
            <p className="text-muted-foreground">
              Reason you gave: {a.cancellation_reason}
            </p>
          ) : null}
          <div className="pt-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link
                href={`/book/${a.doctor_id}?date=${clinicDay(a.starts_at)}`}
              >
                Book another time
              </Link>
            </Button>
          </div>
        </div>
      ) : passed ? (
        <div data-testid="passed-note" className="mt-6 space-y-3 text-base">
          <p>
            This visit was on {when}. It can no longer be moved or cancelled.
          </p>
          <div className="pt-3 flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-12 px-6 text-base">
              <Link href="/appointments">My appointments</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 px-6 text-base"
            >
              <Link href={`/book/${a.doctor_id}`}>Book another visit</Link>
            </Button>
          </div>
        </div>
      ) : (
        <AppointmentActions id={a.id} when={when} startsAt={a.starts_at} />
      )}
    </section>
  );
}
