// Finds bookable times through the API the app under test talks to (the stand-in by default, the
// real API when E2E_API_URL is set), so the same scenarios run against both and never hard-code a
// date: weekends and closed days simply have no slots and are skipped.
export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:3199";

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

// The nth upcoming day (counting from n = 0) on which the first doctor has at least four free
// times. Each scenario passes its own n, so scenarios running in parallel use different days.
export async function pick(n: number): Promise<Picked> {
  const id = await firstDoctor();
  let seen = 0;
  for (let i = 1; i <= 80; i++) {
    const day = addDays(today(), i);
    const a = await getJson<{ slots: { starts_at: string }[] }>(
      `/doctors/${id}/availability?date=${day}`,
    );
    if (a.slots.length >= 4) {
      if (seen === n)
        return { doctorId: id, day, slots: a.slots.map((s) => s.starts_at) };
      seen++;
    }
  }
  throw new Error(`no bookable day number ${n} in the next 80 days`);
}

export async function patientOf(appointmentId: string): Promise<string> {
  const a = await getJson<{ patient_id: string }>(
    `/appointments/${appointmentId}`,
  );
  return a.patient_id;
}
