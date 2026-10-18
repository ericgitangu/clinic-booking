import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@clinic/ui/components/ui/button";
import { SignInPrompt } from "@/components/account/sign-in-prompt";
import { BookingForm } from "@/components/booking/booking-form";
import * as api from "@/lib/api";
import { clinicDay, formatWhen } from "@/lib/clinic-time";
import { heldMessage } from "@/lib/held";
import { ownBooked } from "@/lib/own";
import { heldAt } from "@/lib/slot-chips";
import { getIdentity } from "@/lib/session";

export const metadata: Metadata = {
  title: "Your details",
  robots: { index: false },
};
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export default async function Details({
  params,
  searchParams,
}: {
  params: Promise<{ doctorId: string }>;
  searchParams: Promise<{ starts_at?: string }>;
}) {
  const { doctorId } = await params;
  const { starts_at: startsAt } = await searchParams;
  if (!startsAt || !ISO.test(startsAt) || Number.isNaN(Date.parse(startsAt))) {
    redirect(`/book/${doctorId}`);
  }
  // A link to a time that has gone (an old bookmark, an email, a stale tab) goes to that day's times.
  if (Date.parse(startsAt) <= Date.now()) {
    redirect(`/book/${doctorId}?date=${clinicDay(startsAt)}`);
  }
  const [doctor, who, own] = await Promise.all([
    api.getDoctor(doctorId),
    getIdentity(),
    ownBooked(),
  ]);
  // Already holds this time (with this doctor or another)? Do not offer a booking at all.
  const held = who ? heldAt(own, startsAt) : undefined;
  if (!doctor.ok && doctor.status < 500) notFound();

  return (
    <section className="pb-28 pt-8">
      <p className="text-base">
        <Link
          href={`/book/${doctorId}?date=${clinicDay(startsAt)}`}
          className="underline underline-offset-4"
        >
          Change time
        </Link>
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight">
        Confirm your visit
      </h1>
      <div className="mt-4 rounded-xl border border-border bg-card p-5">
        <p className="text-lg font-semibold">{formatWhen(startsAt)}</p>
        {doctor.ok ? (
          <p className="mt-1 text-base text-muted-foreground">
            {doctor.data.full_name}, {doctor.data.specialty}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          Nairobi time, 30 minutes.
        </p>
      </div>
      <div className="mt-8">
        {held ? (
          <div
            data-testid="already-held"
            className="rounded-xl border border-border bg-muted p-5"
          >
            <h2 className="font-heading text-xl font-semibold">
              You already have a visit at this time
            </h2>
            <p className="mt-2 text-base">
              {heldMessage({
                sameDoctor: held.doctor_id === doctorId,
                when: formatWhen(startsAt),
                doctor: held.doctor_name ?? "your doctor",
              })}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button asChild size="lg" className="h-12 px-6 text-base">
                <Link href="/appointments">My appointments</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 px-6 text-base"
              >
                <Link href={`/book/${doctorId}?date=${clinicDay(startsAt)}`}>
                  Pick another time
                </Link>
              </Button>
            </div>
          </div>
        ) : who ? (
          <BookingForm
            doctorId={doctorId}
            startsAt={startsAt}
            name={who.name}
          />
        ) : (
          <SignInPrompt
            title="Sign in to book"
            body="Your appointments belong to your Google account, so only you can see or change them."
            returnTo={`/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`}
          />
        )}
      </div>
    </section>
  );
}
