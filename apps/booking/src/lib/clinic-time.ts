// The clinic keeps Nairobi time. Everything the booking screens show or compare is in it, whatever
// the visitor's own clock says.
export const CLINIC_TZ = "Africa/Nairobi";

const ymdFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: CLINIC_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "2026-10-17" for the clinic's calendar day containing this instant.
export function clinicDay(d: Date | string): string {
  return ymdFmt.format(typeof d === "string" ? new Date(d) : d);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(day: string | undefined): day is string {
  if (!day || !DAY_RE.test(day)) return false;
  return (
    !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && addDays(day, 0) === day
  );
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CLINIC_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatDayLong(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${day}T00:00:00Z`));
}

export function formatDayShort(day: string): { weekday: string; date: string } {
  const d = new Date(`${day}T00:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
    }).format(d),
    date: new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
    }).format(d),
  };
}

export function formatWhen(iso: string): string {
  return `${formatDayLong(clinicDay(iso))}, ${formatTime(iso)}`;
}
