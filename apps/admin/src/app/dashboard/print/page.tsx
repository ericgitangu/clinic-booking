import type { Metadata } from "next";
import Link from "next/link";
import { ZoneNote } from "@clinic/ui/components/zone-note";
import { PrintButton } from "@/components/print-button";
import { formatTime, humanDate, localDate } from "@/lib/clinic-time";
import { loadDayRows } from "@/lib/dashboard-data";
import { properName } from "@/lib/patient-name";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Today's schedule" };
export const dynamic = "force-dynamic";

// A plain page of today's schedule, one table per doctor, made to be printed. Owner and admin only.
export default async function PrintPage() {
  const staff = await requireStaff("manage-appointments");
  const date = localDate(new Date());
  const rows = await loadDayRows(staff, date);
  const byDoctor = new Map<string, typeof rows>();
  for (const a of rows) {
    byDoctor.set(a.doctor_name, [...(byDoctor.get(a.doctor_name) ?? []), a]);
  }
  return (
    <div className="space-y-6 py-6">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/dashboard"
          className="inline-flex min-h-11 items-center text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Back to the dashboard
        </Link>
        <PrintButton />
      </div>
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Schedule for {humanDate(date)}
      </h1>
      <ZoneNote className="-mt-4" />
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">
          Nothing is booked today.
        </p>
      ) : (
        [...byDoctor].map(([doctor, items]) => (
          <section key={doctor} className="break-inside-avoid space-y-2">
            <h2 className="font-heading text-xl font-semibold">{doctor}</h2>
            <table
              className="w-full text-left text-sm"
              data-testid="print-table"
            >
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Time
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Patient
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="border-b border-border">
                    <td className="py-2 pr-3 tabular-nums">
                      {formatTime(a.starts_at)}
                    </td>
                    <td className="py-2 pr-3">{properName(a.patient_name)}</td>
                    <td className="py-2">
                      {a.status === "booked" ? "Booked" : "Cancelled"}
                      {a.cancellation_reason
                        ? `: ${a.cancellation_reason}`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
