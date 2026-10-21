import { ANCHOR_DAY } from "./support/anchor";

// Finds bookable times through the real API (docker compose), so scenarios never hard-code a date:
// weekends and closed days simply have no slots and are skipped.
export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:8080";

const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });
const hm = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const hhmm = (iso: string) => hm.format(new Date(iso));
export const today = () => ymd.format(new Date());
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export type Picked = {
  doctorId: string;
  day: string;
  slots: string[]; // start times, earliest first, at least four of them
};

let doctorId: Promise<string> | null = null;
export function firstDoctor(): Promise<string> {
  doctorId ??= getJson<{ items: { id: string }[] }>("/doctors").then(
    (d) => d.items[0].id,
  );
  return doctorId;
}

// Scenario n gets its own calendar week, so scenarios running in parallel can never meet on a day,
// whatever else has been booked: the Tuesday n weeks after the first Tuesday that is at least ten
// days out (the landing page's copy-paste steps book within the first week). If that Tuesday has
// fewer than four free times, the next three days of the same week are tried.
function weekStart(n: number): string {
  return addDays(ANCHOR_DAY, 7 * n);
}

// A doctor by position in the API's list. Specs use different doctors where they can, so what one
// books never takes a slot another one is counting on.
const doctors: Promise<string[]> = getJson<{ items: { id: string }[] }>(
  "/doctors",
).then((d) => d.items.map((x) => x.id));
export async function doctorAt(index: number): Promise<string> {
  const ids = await doctors;
  if (!ids[index]) throw new Error(`no doctor number ${index}`);
  return ids[index];
}

// Scenario n gets its own calendar week for the doctor, so scenarios running in parallel never meet
// on a day. With `dayOffset` (0 to 3, Tuesday to Friday) only that day of the week is used, for the
// scenarios that need a date of their own because a reminder run claims everything on a date.
export async function pick(
  n: number,
  opts: { doctor?: number; dayOffset?: number } = {},
): Promise<Picked> {
  const id = await doctorAt(opts.doctor ?? 0);
  const start = weekStart(n);
  const offsets =
    opts.dayOffset === undefined ? [0, 1, 2, 3] : [opts.dayOffset];
  for (const i of offsets) {
    const day = addDays(start, i);
    const a = await getJson<{ slots: { starts_at: string }[] }>(
      `/doctors/${id}/availability?date=${day}`,
    );
    if (a.slots.length >= 4)
      return { doctorId: id, day, slots: a.slots.map((s) => s.starts_at) };
  }
  throw new Error(`no day with four free times in the week of ${start}`);
}

export async function patientOf(appointmentId: string): Promise<string> {
  const a = await getJson<{ patient_id: string }>(
    `/appointments/${appointmentId}`,
  );
  return a.patient_id;
}

// The free times of one doctor on a given day, earliest first.
export async function slotsOn(
  doctorId: string,
  day: string,
): Promise<string[]> {
  const a = await getJson<{ slots: { starts_at: string }[] }>(
    `/doctors/${doctorId}/availability?date=${day}`,
  );
  return a.slots.map((s) => s.starts_at);
}
