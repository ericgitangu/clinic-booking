import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@clinic/ui/components/ui/button";
import { DoctorAvatar } from "@clinic/ui/components/doctor-avatar";
import { pageMetadata } from "@/lib/metadata";
import { listDoctors } from "@/lib/api";

export const metadata: Metadata = pageMetadata({
  title: "Book a visit",
  description: "Choose a doctor, pick a free time in Nairobi time, and book.",
  path: "/book",
});
// The doctor list comes from the API, which is not reachable while the site is being built.
export const dynamic = "force-dynamic";

export default async function BookPage() {
  const res = await listDoctors();
  return (
    <section className="py-10">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Book a visit
      </h1>
      <p className="mt-3 max-w-[60ch] text-lg leading-8 text-muted-foreground">
        Choose a doctor. You will see their free times next, in Nairobi time.
      </p>
      {!res.ok ? (
        <p
          role="alert"
          className="mt-8 rounded-lg border border-border bg-muted p-4 text-base"
        >
          We could not load the doctors just now. Reload the page in a moment.
        </p>
      ) : res.data.items.length === 0 ? (
        <p className="mt-8 text-base">No doctors are available to book yet.</p>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {res.data.items.map((d) => (
            <li
              key={d.id}
              className="flex flex-col rounded-xl border border-border bg-card p-5"
            >
              <div className="flex items-center gap-4">
                <span aria-hidden="true">
                  <DoctorAvatar doctorId={d.id} name={d.full_name} size={56} />
                </span>
                <div>
                  <h2 className="font-heading text-xl font-semibold">
                    {d.full_name}
                  </h2>
                  <p className="mt-1 text-base text-muted-foreground">
                    {d.specialty}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {d.clinic.name}
                  </p>
                </div>
              </div>
              <Button asChild size="lg" className="mt-5 h-12 text-base">
                <Link href={`/book/${d.id}`}>See free times</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
