// Dates here are clinic-local (Africa/Nairobi), as the API's ranges are.
export const CLINIC_TZ = "Africa/Nairobi";

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ });

/** The clinic-local calendar date of an instant, as YYYY-MM-DD. */
export function localDate(at: Date): string {
  return dayKey.format(at);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The inclusive-exclusive range of the last `days` clinic-local days, ending with today. */
export function lastDays(
  now: Date,
  days: number,
): { from: string; to: string } {
  const today = localDate(now);
  return { from: addDays(today, 1 - days), to: addDays(today, 1) };
}

const slot = new Intl.DateTimeFormat("en-GB", {
  timeZone: CLINIC_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "Tue 20 Oct, 09:00" in clinic time. */
export function formatSlot(iso: string): string {
  return slot.format(new Date(iso)).replace(",", "");
}

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: CLINIC_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

const shortDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});

/** "20 Oct" for a bucket start such as 2026-10-20T00:00:00 (already clinic-local). */
export function formatBucket(bucketStart: string): string {
  return shortDay.format(new Date(`${bucketStart.slice(0, 10)}T00:00:00Z`));
}

/** Every day of [from, to) as YYYY-MM-DD. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

const longDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: CLINIC_TZ,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

/** "Tuesday 20 October 2026" for a clinic-local date such as 2026-10-20. */
export function humanDate(day: string): string {
  // Noon UTC is mid-afternoon in the clinic zone, so the day cannot slip either way.
  return longDay.format(new Date(`${day}T12:00:00Z`)).replace(",", "");
}
