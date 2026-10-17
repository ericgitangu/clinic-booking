import "server-only";
import { unstable_cache } from "next/cache";
import type { ApiResult } from "@clinic/api/call";
import type { LineageEvent, Metrics } from "@clinic/api/generated";
import {
  appointmentsPage,
  lineage,
  metrics,
  type AppointmentQuery,
} from "@/lib/api";
import { addDays, lastDays, localDate } from "@/lib/clinic-time";
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
  range: Metrics;
  week: Metrics;
  todayBooked: number;
  todayCapped: boolean;
  utilisation: number | null;
}

export async function loadDashboard(
  staff: Authorised,
  days: number,
  now: Date,
): Promise<Dashboard> {
  const caller = callerFor(staff, staff.role);
  const range = lastDays(now, days);
  const week = lastDays(now, 7);
  const today = localDate(now);

  const [rangeRes, weekRes, todayRes] = await Promise.all([
    cachedMetrics(staff, range.from, range.to),
    days === 7 ? null : cachedMetrics(staff, week.from, week.to),
    appointmentsPage(caller, {
      status: "booked",
      from: today,
      to: addDays(today, 1),
      limit: 100,
    }),
  ]);
  const rangeMetrics = rangeRes;
  const weekMetrics = weekRes ?? rangeMetrics;
  const todayPage = unwrap(todayRes, "today's appointments");

  const visits = rangeMetrics.per_doctor.reduce(
    (n, d) => n + d.booked_visits,
    0,
  );
  const capacity = rangeMetrics.per_doctor.reduce((n, d) => n + d.capacity, 0);
  return {
    range: rangeMetrics,
    week: weekMetrics,
    todayBooked: todayPage.items.length,
    todayCapped:
      todayPage.next_cursor !== null && todayPage.next_cursor !== undefined,
    utilisation: capacity > 0 ? visits / capacity : null,
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
