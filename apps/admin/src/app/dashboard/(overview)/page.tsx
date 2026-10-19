import type { Metadata } from "next";
import { ActivityChart, type ActivityRow } from "@/components/activity-chart";
import { AppointmentsList } from "@/components/appointments-list";
import { DoctorUtilisation } from "@/components/doctor-utilisation";
import { LiveFeed } from "@/components/live-feed";
import { PeakHours } from "@/components/peak-hours";
import { ReasonsChart } from "@/components/reasons-chart";
import { GapsToFill } from "@/components/gaps-to-fill";
import { TodayBoard } from "@/components/today-board";
import { KpiStrip } from "@/components/kpi-strip";
import { RefreshButton } from "@/components/refresh-button";
import { SegmentedControl } from "@/components/segmented-control";
import {
  addDays,
  eachDay,
  formatBucket,
  lastDays,
  localDate,
} from "@/lib/clinic-time";
import { loadAppointments, loadDashboard } from "@/lib/dashboard-data";
import {
  RANGES,
  STATUSES,
  STATUS_LABEL,
  type StatusFilterValue,
} from "@/lib/filters";
import {
  countDelta,
  durationDelta,
  formatLead,
  shareDelta,
} from "@/lib/kpi-delta";
import type { DrillConfig } from "@/lib/drill";
import { can } from "@/lib/roles";
import { requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type Search = Promise<{
  days?: string;
  status?: string;
  cursor?: string;
  doctor?: string;
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
  const doctor =
    q.doctor && /^[0-9a-f-]{36}$/i.test(q.doctor) ? q.doctor : null;
  const now = new Date();

  // Independent reads, started together so the page waits for the slowest one only.
  const [dash, page] = await Promise.all([
    loadDashboard(staff, days, now, doctor ?? undefined),
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

  const mayAct = can(staff.role, "manage-appointments");
  const k = dash.kpis;
  const pct = (v: number | null) =>
    v === null ? "None" : `${Math.round(v * 100)}%`;
  const todayDay = localDate(now);
  const range = { from, to };
  const inRange = (
    title: string,
    what: string,
    extra: Partial<DrillConfig> = {},
  ) =>
    ({
      title,
      description: `${what} starting in the last ${days} days.`,
      spec: { ...range, status: "booked" as const },
      ...extra,
    }) satisfies DrillConfig;
  const lead = (m: number | null) => (m === null ? null : m / 60);

  return (
    <div className="space-y-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Range"
            name="days"
            value={String(days)}
            options={RANGES.map((d) => ({
              value: String(d),
              label: `${d} days`,
            }))}
          />
          <RefreshButton />
        </div>
      </div>

      <TodayBoard
        board={dash.today}
        date={localDate(now)}
        now={now}
        canAct={mayAct}
        canExport={mayAct}
      />

      <LiveFeed
        role={staff.role}
        doctors={dash.range.per_doctor.map((d) => ({
          id: d.doctor_id,
          name: d.name,
        }))}
      />

      <GapsToFill gaps={dash.gaps} canBook={mayAct} />

      <KpiStrip
        comparedWith={`the ${days} days before`}
        items={[
          {
            label: "Upcoming booked",
            value: String(dash.range.totals.upcoming_active),
            note: "from now on, all doctors",
            drill: {
              title: "Upcoming booked visits",
              description:
                "Booked visits that have not started yet, all doctors.",
              spec: {
                from: todayDay,
                to: addDays(todayDay, 366),
                status: "booked",
              },
              upcoming: true,
            },
          },
          {
            label: "Cancelled visits",
            value: String(k.counts.cancelled),
            note: `visits starting in the last ${days} days`,
            drill: inRange("Cancelled visits", "Cancelled visits", {
              spec: { ...range, status: "cancelled" },
            }),
          },
          {
            label: "Fill rate",
            value: pct(k.fill_rate.value),
            note: `${k.counts.booked} booked of ${k.counts.offered} slots offered`,
            drill: inRange("Booked visits", "Booked visits, arrived or not,"),
            delta: shareDelta(
              k.fill_rate.value,
              k.fill_rate.previous,
              "up",
              "No slots offered before",
            ),
          },
          {
            label: "Utilisation",
            value: pct(k.utilisation.value),
            note: `${k.counts.arrived} arrived of ${k.counts.offered} offered`,
            drill: inRange(
              "Visits that arrived",
              "Booked visits, opened on those marked arrived,",
              {
                visit: "arrived",
              },
            ),
            delta: shareDelta(
              k.utilisation.value,
              k.utilisation.previous,
              "up",
              "No slots offered before",
            ),
          },
          {
            label: "Cancellation rate",
            value: pct(k.cancellation_rate.value),
            note: "cancellations per booking made",
            drill: inRange("Cancelled visits", "Cancelled visits", {
              spec: { ...range, status: "cancelled" },
            }),
            delta: shareDelta(
              k.cancellation_rate.value,
              k.cancellation_rate.previous,
              "down",
              "No bookings before",
            ),
          },
          {
            label: "No-show rate",
            value: pct(k.no_show_rate.value),
            note: `${k.counts.no_show} marked no-show at the desk`,
            drill: inRange(
              "No-shows",
              "Booked visits, opened on those marked no-show at the desk,",
              {
                visit: "no_show",
              },
            ),
            delta: shareDelta(
              k.no_show_rate.value,
              k.no_show_rate.previous,
              "down",
              "No marked visits before",
            ),
          },
          {
            label: "Median lead time",
            value:
              k.median_lead_minutes.value === null
                ? "None"
                : formatLead(k.median_lead_minutes.value / 60),
            note: "booked visits starting in the range",
            drill: inRange("Booked visits and how far ahead", "Booked visits", {
              showLead: true,
            }),
            delta: durationDelta(
              lead(k.median_lead_minutes.value),
              lead(k.median_lead_minutes.previous),
            ),
          },
          {
            label: "Reschedules",
            value: String(k.reschedules.value ?? 0),
            note: `in the last ${days} days`,
            delta: countDelta(
              k.reschedules.value ?? 0,
              k.reschedules.previous ?? 0,
              "none",
            ),
          },
        ]}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <ActivityChart rows={rows} />
        <DoctorUtilisation
          doctors={dash.range.per_doctor}
          days={days}
          range={range}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ReasonsChart data={dash.reasons} days={days} />
        <PeakHours
          data={dash.heatmap}
          doctors={dash.today.doctors.map((d) => ({
            id: d.doctor_id,
            name: d.name,
          }))}
          selected={doctor}
          days={days}
          range={range}
        />
      </div>

      <section
        id="appts-section"
        aria-labelledby="appts"
        className="scroll-mt-4 space-y-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="appts"
            className="font-heading text-xl font-semibold tracking-tight"
          >
            Appointments
          </h2>
          <SegmentedControl
            label="Show"
            name="status"
            value={status}
            options={STATUSES.map((s) => ({
              value: s,
              label: STATUS_LABEL[s],
            }))}
          />
        </div>
        <AppointmentsList
          items={page.items}
          view={page.view}
          status={status}
          nextHref={
            page.next_cursor ? link({ cursor: page.next_cursor }) : null
          }
          firstHref={cursor ? link({}) : null}
        />
      </section>

      <p className="hidden items-center gap-1.5 text-sm text-muted-foreground md:flex">
        Press{" "}
        <kbd className="rounded-md border border-border bg-muted px-1.5 text-xs font-medium text-foreground">
          ?
        </kbd>{" "}
        for keyboard shortcuts (and to turn them off), or{" "}
        <kbd className="rounded-md border border-border bg-muted px-1.5 text-xs font-medium text-foreground">
          /
        </kbd>{" "}
        to search.
      </p>
    </div>
  );
}
