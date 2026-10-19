import type { Metadata } from "next";
import { ActivityChart, type ActivityRow } from "@/components/activity-chart";
import { AppointmentsList } from "@/components/appointments-list";
import { DoctorUtilisation } from "@/components/doctor-utilisation";
import { KpiStrip } from "@/components/kpi-strip";
import { LiveFeed } from "@/components/live-feed";
import { liveKey } from "@/lib/live-key";
import { RangeNav } from "@/components/range-nav";
import { RefreshButton } from "@/components/refresh-button";
import { StaffBar } from "@/components/staff-bar";
import { StatusFilter } from "@/components/status-filter";
import { eachDay, formatBucket, lastDays } from "@/lib/clinic-time";
import { loadAppointments, loadDashboard } from "@/lib/dashboard-data";
import { RANGES, STATUSES, type StatusFilterValue } from "@/lib/filters";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Search = Promise<{
  days?: string;
  status?: string;
  cursor?: string;
}>;

function pick<T extends string | number>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const found = allowed.find((a) => String(a) === value);
  return found ?? fallback;
}

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Search;
}) {
  const staff = await requireStaff("view");
  const q = await searchParams;
  const days = pick(q.days, RANGES, 14);
  const status: StatusFilterValue = pick(q.status, STATUSES, "all");
  const cursor = q.cursor && q.cursor.length < 400 ? q.cursor : null;
  const now = new Date();

  // Independent reads, started together so the page waits for the slowest one only.
  const [dash, page] = await Promise.all([
    loadDashboard(staff, days, now),
    loadAppointments(staff, status, cursor),
  ]);

  const { from, to } = lastDays(now, days);
  const byDay = new Map(
    dash.range.series.map((p) => [p.bucket_start.slice(0, 10), p]),
  );
  // The API returns only days that had activity; the chart needs every day, so gaps become zeros.
  const rows: ActivityRow[] = eachDay(from, to).map((d) => {
    const p = byDay.get(d);
    return {
      label: formatBucket(`${d}T00:00:00`),
      booked: p?.booked ?? 0,
      rescheduled: p?.rescheduled ?? 0,
      cancelled: p?.cancelled ?? 0,
    };
  });

  const link = (extra: Record<string, string>) => {
    const sp = new URLSearchParams({ days: String(days), status, ...extra });
    return `/dashboard?${sp.toString()}`;
  };

  return (
    <>
      <StaffBar
        name={staff.name}
        email={staff.email}
        image={staff.image}
        role={staff.role}
      />
      <div className="space-y-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Dashboard
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <RangeNav days={days} />
            <RefreshButton />
          </div>
        </div>

        <KpiStrip
          items={[
            {
              label: "Upcoming booked",
              value: String(dash.range.totals.upcoming_active),
              note: "from now on, all doctors",
            },
            {
              label: "Today",
              value: `${dash.todayBooked}${dash.todayCapped ? "+" : ""}`,
              note: "booked appointments",
            },
            {
              label: "Cancellations",
              value: String(dash.week.totals.cancelled),
              note: "in the last 7 days",
            },
            {
              label: "Utilisation",
              value:
                dash.utilisation === null
                  ? "None"
                  : `${Math.round(dash.utilisation * 100)}%`,
              note: `of working slots, last ${days} days`,
            },
          ]}
        />

        <LiveFeed
          role={staff.role}
          person={liveKey(staff.sub)}
          doctors={dash.range.per_doctor.map((d) => ({
            id: d.doctor_id,
            name: d.name,
          }))}
        />

        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <ActivityChart rows={rows} />
          <DoctorUtilisation doctors={dash.range.per_doctor} />
        </div>

        <section aria-labelledby="appts" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="appts"
              className="font-heading text-xl font-semibold tracking-tight"
            >
              Appointments
            </h2>
            <StatusFilter status={status} />
          </div>
          <AppointmentsList
            items={page.items}
            nextHref={
              page.next_cursor ? link({ cursor: page.next_cursor }) : null
            }
            firstHref={cursor ? link({}) : null}
          />
        </section>
      </div>
    </>
  );
}
