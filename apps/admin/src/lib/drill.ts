// The drill-down behind a number: the appointments that make it up. The rows are read from the
// admin list (which the API minimises by role); everything here is a pure rule over those rows, so
// the count in the sheet is the count of the rows shown and nothing else.
import { CLINIC_TZ } from "@/lib/clinic-time";
import { visitStatus, type VisitStatus } from "@/components/status-badge";

export interface DrillSpec {
  /** Clinic-local dates, [from, to): the same convention as the API's list. */
  from: string;
  to: string;
  status: "all" | "booked" | "cancelled";
  doctorId?: string;
}

/** What a card or section promises its list holds; the sheet starts with exactly this. */
export interface DrillConfig {
  title: string;
  description: string;
  spec: DrillSpec;
  /** The status choice the sheet opens on, so it starts as exactly what the card counts. */
  visit?: VisitStatus;
  /** Only visits that have not started yet. */
  upcoming?: boolean;
  /** Only visits starting at this weekday (1 = Monday) and hour (0 to 23), clinic time. */
  slot?: { weekday: number; hour: number };
  /** Show how far ahead each visit was booked. */
  showLead?: boolean;
  /** The number the sheet was opened from. If the list is cut short, the sheet says "of N". */
  expected?: number;
}

export interface DrillRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  patient_name: string;
  starts_at: string;
  created_at: string;
  status: "booked" | "cancelled";
  attendance: "arrived" | "no_show" | null;
}

export type StatusChoice = "all" | VisitStatus;

export interface Filters {
  status: StatusChoice;
  doctorId: string;
}

const WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const parts = new Intl.DateTimeFormat("en-GB", {
  timeZone: CLINIC_TZ,
  weekday: "short",
  hour: "2-digit",
  hour12: false,
});

/** Weekday (1 = Monday) and hour of an instant in clinic time. */
export function weekdayHour(iso: string): { weekday: number; hour: number } {
  const p = Object.fromEntries(
    parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return {
    weekday: WEEKDAY[p.weekday ?? ""] ?? 0,
    hour: Number(p.hour) % 24,
  };
}

/**
 * The rows a card promised, then the person's own narrowing. `nowMs` is the server's clock when the
 * rows were read, never the device's.
 */
export function applyDrill(
  rows: readonly DrillRow[],
  cfg: DrillConfig,
  f: Filters,
  nowMs: number,
): DrillRow[] {
  return rows.filter((r) => {
    const status = visitStatus(r);
    if (cfg.upcoming && !(Date.parse(r.starts_at) >= nowMs)) return false;
    if (cfg.slot) {
      const w = weekdayHour(r.starts_at);
      if (w.weekday !== cfg.slot.weekday || w.hour !== cfg.slot.hour)
        return false;
    }
    if (f.status !== "all" && status !== f.status) return false;
    if (f.doctorId && r.doctor_id !== f.doctorId) return false;
    return true;
  });
}

/** Hours between booking and the visit. */
export function leadHours(
  r: Pick<DrillRow, "created_at" | "starts_at">,
): number {
  return (Date.parse(r.starts_at) - Date.parse(r.created_at)) / 3_600_000;
}

/** The line above the list. A list cut at the read bound says so, with the number it was opened from. */
export function countLine(o: {
  shown: number;
  truncated: boolean;
  expected?: number;
}): string {
  const visits = (n: number) => `${n} ${n === 1 ? "visit" : "visits"}`;
  if (!o.truncated) return visits(o.shown);
  const of = o.expected !== undefined ? ` of ${o.expected}` : "";
  return `Showing ${o.shown}${of} visits. The list is cut short; narrow the dates to see the rest.`;
}
