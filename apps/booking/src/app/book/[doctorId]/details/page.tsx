import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SignInPrompt } from "@/components/account/sign-in-prompt";
import { BookingForm } from "@/components/booking/booking-form";
import * as api from "@/lib/api";
import { clinicDay, formatWhen } from "@/lib/clinic-time";
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
  const [doctor, who] = await Promise.all([
    api.getDoctor(doctorId),
    getIdentity(),
  ]);
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
        {who ? (
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
