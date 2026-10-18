import { API, addDays, today, type Picked } from "../api";

// A calendar cell owned by one test instance: a doctor on a working day of week 9 after the first
// Tuesday that is at least ten days out (the shared helpers use weeks 0 to 8, so nothing else
// writes here). The cells are every (day, doctor) pair, Monday to Friday, in which the doctor works
// at least two hours, read from the doctors' own working hours, so the list is the same whatever
// has been booked. Instance i takes cell i: two tests, two repeats of one test, or one test in
// two workers never share a day. The week stays inside the 90 day booking horizon; asking for
// more cells than the week has fails loudly instead of colliding.
const CELL_WEEK = 9;
const MIN_HOURS = 2;

const isTuesday = (day: string) =>
  new Date(`${day}T12:00:00Z`).getUTCDay() === 2;
function firstTuesdayOffset(): number {
  let d = 10;
  while (!isTuesday(addDays(today(), d))) d++;
  return d;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

type Doctor = {
  id: string;
  working_hours: { weekday: number; start_time: string; end_time: string }[];
};

const hours = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;

export async function ownCell(i: number): Promise<Picked> {
  const { items } = await getJson<{ items: { id: string }[] }>("/doctors");
  const doctors = await Promise.all(
    items.map((d) => getJson<Doctor>(`/doctors/${d.id}`)),
  );
  const monday = addDays(today(), firstTuesdayOffset() + 7 * CELL_WEEK - 1);
  const cells: { doctorId: string; day: string }[] = [];
  for (let offset = 0; offset < 5; offset++) {
    const day = addDays(monday, offset);
    const weekday = offset + 1; // 1 = Monday
    for (const d of doctors) {
      if (
        d.working_hours.some(
          (w) =>
            w.weekday === weekday &&
            hours(w.end_time) - hours(w.start_time) >= MIN_HOURS,
        )
      )
        cells.push({ doctorId: d.id, day });
    }
  }
  if (i >= cells.length) {
    throw new Error(
      `cell ${i} does not exist: the week has ${cells.length}; run fewer repeats`,
    );
  }
  const { doctorId, day } = cells[i];
  const a = await getJson<{ slots: { starts_at: string }[] }>(
    `/doctors/${doctorId}/availability?date=${day}`,
  );
  if (a.slots.length < 4) {
    throw new Error(`cell ${i}: only ${a.slots.length} free times on ${day}`);
  }
  return { doctorId, day, slots: a.slots.map((s) => s.starts_at) };
}
