import "server-only";
import { unstable_cache } from "next/cache";
import type { ApiResult } from "@clinic/api/call";
import type {
  AdminAppointment,
  GapList,
  Heatmap,
  Kpis,
  LineageEvent,
  Metrics,
  ReasonBreakdown,
  TodayBoard,
} from "@clinic/api/generated";
import {
  adminAppointment,
  appointmentsPage,
  lineage,
  metrics,
  opsGaps,
  opsHeatmap,
  opsKpis,
  opsReasons,
  opsToday,
  type AppointmentQuery,
} from "@/lib/api";
import { addDays, lastDays, localDate } from "@/lib/clinic-time";
import { can } from "@/lib/roles";
import { assertMayReadMetrics, metricsCachePlan } from "@/lib/metrics-cache";
import { callerFor, type Authorised } from "@/lib/session";

function unwrap<T>(res: ApiResult<T>, what: string): T {
  if (!res.ok) {
    // The error boundary shows a fixed message; the status and code go to the server log.
    throw new Error(`${what} failed (${res.status} ${res.code})`);
  }
  return res.data;
}

// The clinic-wide metrics, cached for 60 seconds under one tag. The caller has already
// been checked (requireStaff on the page, and the check below), outside the cache: a cached value
// is only ever returned to someone who holds a role that may view. The cached function throws on a
// failure, so an error is never stored; the signed caller is a closure, not part of the key,
// because the figures are the same for every role.
async function cachedMetrics(
  staff: Authorised,
  from: string,
  to: string,
): Promise<Metrics> {
  assertMayReadMetrics(staff.role);
  const { keyParts, options } = metricsCachePlan(from, to, "day");
  return unstable_cache(
    async () =>
      unwrap(await metrics(callerFor(staff, staff.role), from, to), "metrics"),
    keyParts,
    options,
  )();
}

export interface Dashboard {
  /** The metrics read: the activity series and the per-doctor load. Cached for a minute. */
  range: Metrics;
  /** Utilisation, fill, cancellation, no-show, lead time and reschedules, each with its change. */
  kpis: Kpis;
  /** Today for every doctor, with attendance, the next free gap and the running-behind flag. */
  today: TodayBoard;
  /** Free 30-minute slots in the next 48 hours. */
  gaps: GapList;
  /** Why visits were cancelled in the range, grouped into categories. */
  reasons: ReasonBreakdown;
  /** Booked visits by weekday and start hour in the range, for the clinic or one doctor. */
  heatmap: Heatmap;
}

// Six independent reads started together, so the page waits for the slowest one only. The figures
// that need a definition (rates, lead time, running behind) come from the API's read model; this
// app does not recompute them.
export async function loadDashboard(
  staff: Authorised,
  days: number,
  now: Date,
  heatmapDoctor?: string,
): Promise<Dashboard> {
  const caller = callerFor(staff, staff.role);
  const range = lastDays(now, days);
  const [rangeMetrics, kpis, today, gaps, reasons, heatmap] = await Promise.all(
    [
      cachedMetrics(staff, range.from, range.to),
      opsKpis(caller, range.from, range.to),
      opsToday(caller, localDate(now)),
      opsGaps(caller, 48),
      opsReasons(caller, range.from, range.to),
      opsHeatmap(caller, range.from, range.to, heatmapDoctor),
    ],
  );
  return {
    range: rangeMetrics,
    kpis: unwrap(kpis, "kpis"),
    today: unwrap(today, "today board"),
    gaps: unwrap(gaps, "gaps"),
    reasons: unwrap(reasons, "cancellation reasons"),
    heatmap: unwrap(heatmap, "heatmap"),
  };
}

export async function loadAppointments(
  staff: Authorised,
  status: NonNullable<AppointmentQuery["status"]>,
  cursor: string | null,
) {
  return unwrap(
    await appointmentsPage(callerFor(staff, staff.role), {
      status,
      limit: 10,
      cursor,
    }),
    "appointments",
  );
}

export async function loadLineage(
  staff: Authorised,
  id: string,
): Promise<{ found: true; events: LineageEvent[] } | { found: false }> {
  const res = await lineage(callerFor(staff, staff.role), id);
  if (!res.ok && res.status === 404) return { found: false };
  return { found: true, events: unwrap(res, "lineage").events };
}

/**
 * One appointment as the admin list shows it, through the single-appointment read (the API
 * minimises it by role like the list). Null when it does not exist (or is synthetic). `view` says
 * how to show the name: a viewer's is already initials and is shown as sent. That mapping is the
 * API's own rule (owner and admin full, everyone else minimised); the data itself is the API's
 * projection, never re-derived here.
 */
export async function loadAppointmentRow(
  staff: Authorised,
  id: string,
): Promise<(AdminAppointment & { view: "full" | "minimised" }) | null> {
  const res = await adminAppointment(callerFor(staff, staff.role), id);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`appointment failed (${res.status} ${res.code})`);
  }
  return {
    ...res.data,
    view: can(staff.role, "manage-appointments") ? "full" : "minimised",
  };
}

export async function loadAppointmentsRaw(
  caller: ReturnType<typeof callerFor>,
  date: string,
  cursor: string | null,
) {
  return unwrap(
    await appointmentsPage(caller, {
      status: "all",
      from: date,
      to: addDays(date, 1),
      limit: 100,
      cursor,
    }),
    "today's appointments",
  );
}

/** Every appointment of one clinic-local day, all statuses, earliest first (bounded at 300). */
export async function loadDayRows(
  staff: Authorised,
  date: string,
): Promise<AdminAppointment[]> {
  const caller = callerFor(staff, staff.role);
  const rows: AdminAppointment[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 3; i++) {
    const page: Awaited<ReturnType<typeof loadAppointmentsRaw>> =
      await loadAppointmentsRaw(caller, date, cursor);
    rows.push(...page.items);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return rows.sort(
    (a, b) =>
      a.doctor_name.localeCompare(b.doctor_name) ||
      a.starts_at.localeCompare(b.starts_at),
  );
}
