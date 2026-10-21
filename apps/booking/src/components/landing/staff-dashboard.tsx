import Image from "next/image";

export const STAFF_URL = "https://clinic-admin.ericgitangu.com";

const POINTS = [
  "See today's board and the KPIs, and open any of them for its detail view.",
  "Watch bookings, changes and vetoes arrive live, over the Go feed running inside Google Cloud.",
  "Veto a patient's change and lock it, with a reason that stays in the audit trail.",
  "Mark arrivals, book on a patient's behalf, and invite other staff.",
];

// The two screenshots are of the admin app on a local stack with the demo seed, signed in as the
// owner. Patients are the seed's invented people, and the only addresses shown are on the reserved
// .example domain. Each is three crops of one page, taken at twice the size for sharp screens and
// joined top to bottom: the Today board, the live feed, the KPI row. Only the one for the current
// colour scheme is displayed.
export function StaffDashboard() {
  return (
    <section aria-labelledby="staff" className="py-12">
      <h2
        id="staff"
        className="font-heading text-2xl font-semibold tracking-tight"
      >
        For clinic staff
      </h2>
      <ul className="mt-3 max-w-[65ch] list-disc space-y-2 pl-5 text-base leading-7 text-muted-foreground">
        {POINTS.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <p className="mt-4 max-w-[65ch] text-base leading-7">
        Access is by invitation from the owner.
      </p>
      <figure className="mt-6 max-w-4xl">
        <Image
          src="/screenshots/staff-dashboard-light.webp"
          alt="The staff dashboard in the light theme, in three cropped parts. The Today board shows two doctors with portraits and their visits: most marked Arrived or No-show, two cancelled and one still booked with Reschedule and Cancel buttons, and one doctor's arrival email. The live feed, with a count of five new events, lists a new booking, a reschedule, the owner's veto with its reason and the move back to the original time, and an arrival. Below it are KPI cards for visits today, upcoming booked, cancelled visits and fill rate. All names are invented."
          width={1280}
          height={1576}
          sizes="(min-width: 960px) 896px, calc(100vw - 32px)"
          className="h-auto w-full rounded-md border border-border dark:hidden"
        />
        <Image
          src="/screenshots/staff-dashboard-dark.webp"
          alt="The staff dashboard in the dark theme, in three cropped parts. The Today board shows two doctors with portraits and their visits: most marked Arrived or No-show, two cancelled and one still booked with Reschedule and Cancel buttons, and one doctor's arrival email. The live feed, with a count of five new events, lists a new booking, a reschedule, the owner's veto with its reason and the move back to the original time, and an arrival. Below it are KPI cards for visits today, upcoming booked, cancelled visits and fill rate. All names are invented."
          width={1280}
          height={1576}
          sizes="(min-width: 960px) 896px, calc(100vw - 32px)"
          className="hidden h-auto w-full rounded-md border border-border dark:block"
        />
        <figcaption className="mt-2 text-sm text-muted-foreground">
          Three parts of the dashboard, joined, on demo data. The patient names
          are invented.
        </figcaption>
      </figure>
    </section>
  );
}
