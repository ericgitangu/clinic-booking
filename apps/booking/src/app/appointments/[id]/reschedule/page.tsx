import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DateStrip } from "@/components/booking/date-strip";
import { SlotChooser } from "@/components/booking/slot-chooser";
import { isForbidden, needsSignIn } from "@/lib/auth-failure";
import { NoAccess } from "@/components/account/no-access";
import * as api from "@/lib/api";
import {
  clinicDay,
  formatDayLong,
  formatWhen,
  isValidDay,
} from "@/lib/clinic-time";
import { CHANGE_WINDOW_NOTE, insideChangeWindow } from "@/lib/change-window";
import { ChangeWindowWatch } from "@/components/booking/change-window-watch";
import { shouldTrackRenders } from "@/lib/test-run";
import { ownBooked } from "@/lib/own";
import { SignInPrompt } from "@/components/account/sign-in-prompt";
import { callerFor, getIdentity } from "@/lib/session";

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
  const who = await getIdentity();
  if (!who) {
    return (
      <SignInPrompt
        title="Sign in to reschedule"
        body="Only the account that booked an appointment can change it."
        returnTo={`/appointments/${id}/reschedule`}
      />
    );
  }
  // 404 for an appointment that is not this person's, the same as for one that does not exist.
  const appt = await api.myAppointment(callerFor(who), id);
  if (!appt.ok) {
    if (isForbidden(appt))
      return (
        <NoAccess back={{ href: "/appointments", label: "My appointments" }} />
      );
    if (needsSignIn(appt)) {
      return (
        <SignInPrompt
          title="Sign in to reschedule"
          body="Your session has ended. Sign in again with the Google account that booked."
          returnTo={`/appointments/${id}/reschedule`}
        />
      );
    }
    notFound();
  }

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

  if (insideChangeWindow(appt.data.starts_at, Date.now())) {
    return (
      <section className="py-10">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Reschedule
        </h1>
        <p role="status" className="mt-4 text-base">
          {CHANGE_WINDOW_NOTE}{" "}
          <Link href="/appointments" className="underline underline-offset-4">
            My appointments
          </Link>
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
  const [avail, own] = await Promise.all([
    api.getAvailability(appt.data.doctor_id, day),
    ownBooked(),
  ]);

  return (
    <section className="pb-28 pt-8">
      <ChangeWindowWatch
        startsAt={appt.data.starts_at}
        serverNow={new Date().toISOString()}
      />
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
            trackRenders={shouldTrackRenders(process.env)}
            key={`${avail.data.doctor_id}-${avail.data.date}`}
            mode="reschedule"
            appointmentId={id}
            availability={avail.data}
            own={own}
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
