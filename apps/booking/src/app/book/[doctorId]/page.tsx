import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { SlotChooser } from "@/components/booking/slot-chooser";
import { DateStrip } from "@/components/booking/date-strip";
import * as api from "@/lib/api";
import { clinicDay, formatDayLong, isValidDay } from "@/lib/clinic-time";
import { ownBooked } from "@/lib/own";
import { describeProblem } from "@/lib/problems";

// Doctor pages are listed in the sitemap, so they are indexable. The canonical address drops the
// ?date= choice; the share card (title, description) is inherited from the root layout.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ doctorId: string }>;
}): Promise<Metadata> {
  const { doctorId } = await params;
  const path = `/book/${doctorId}`;
  return {
    title: "Pick a time",
    alternates: { canonical: path },
    openGraph: { url: path },
  };
}
export const dynamic = "force-dynamic";

export default async function PickTime({
  params,
  searchParams,
}: {
  params: Promise<{ doctorId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { doctorId } = await params;
  const { date } = await searchParams;
  const today = clinicDay(new Date());
  const day = isValidDay(date) ? date : today;

  const [doctor, avail, own] = await Promise.all([
    api.getDoctor(doctorId),
    api.getAvailability(doctorId, day),
    ownBooked(),
  ]);
  if (
    !doctor.ok &&
    (doctor.code === "DOCTOR_NOT_FOUND" ||
      doctor.status === 404 ||
      doctor.status === 422)
  ) {
    notFound();
  }

  return (
    <section className="pb-12 pt-8">
      <p className="text-base">
        <Link href="/book" className="underline underline-offset-4">
          All doctors
        </Link>
      </p>
      {doctor.ok ? (
        <>
          <div className="mt-3 flex items-center gap-4">
            <span aria-hidden="true">
              <DoctorAvatar
                doctorId={doctor.data.id}
                name={doctor.data.full_name}
                size={64}
              />
            </span>
            <div>
              <h1 className="font-heading text-3xl font-semibold tracking-tight">
                {doctor.data.full_name}
              </h1>
              <p className="mt-1 text-base text-muted-foreground">
                {doctor.data.specialty}. Times are Nairobi time.
              </p>
            </div>
          </div>
        </>
      ) : (
        <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight">
          Pick a time
        </h1>
      )}

      <div className="mt-6">
        <DateStrip
          today={today}
          selected={day}
          basePath={`/book/${doctorId}`}
        />
      </div>

      <h2 className="mt-8 font-heading text-xl font-semibold">
        {formatDayLong(day)}
      </h2>
      <div className="mt-4">
        {avail.ok ? (
          <SlotChooser
            key={`${avail.data.doctor_id}-${avail.data.date}`}
            mode="details"
            doctorId={doctorId}
            availability={avail.data}
            own={own}
          />
        ) : (
          <p
            role="alert"
            className="rounded-lg border border-border bg-muted p-4 text-base"
          >
            {avail.code === "DATE_OUT_OF_RANGE" ||
            avail.code === "VALIDATION_ERROR"
              ? describeProblem("DATE_OUT_OF_RANGE").message
              : "We could not load the free times. Reload the page in a moment."}
          </p>
        )}
      </div>
    </section>
  );
}
