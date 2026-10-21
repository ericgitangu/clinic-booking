import { API, addDays, type Picked } from "../api";
import { ANCHOR_DAY } from "./anchor";

// A calendar cell owned by one test instance: a doctor on a working day of week 9 after the first
// Tuesday that is at least ten days out (the shared helpers use weeks 0 to 8, so nothing else
// writes here). The cells are every (day, doctor) pair, Monday to Friday, in which the doctor works
// at least two hours, read from the doctors' own working hours, so the list is the same whatever
// has been booked. Instance i takes cell i: two tests, two repeats of one test, or one test in
// two workers never share a day. The week stays inside the 90 day booking horizon; asking for
// more cells than the week has fails loudly instead of colliding.
const CELL_WEEK = 9;
const MIN_HOURS = 2;

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
  const monday = addDays(ANCHOR_DAY, 7 * CELL_WEEK - 1);
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

// A cell for scenarios that can use any doctor except the first: doctors 1 to 4 on a working day of
// weeks 0 to 8 (the shared helpers take only the first doctor in those weeks, so nothing else
// writes here). Cells are ordered by week, day, doctor; instance i takes cell i. Plenty of them:
// about 140.
export async function farCell(i: number): Promise<Picked> {
  const { items } = await getJson<{ items: { id: string }[] }>("/doctors");
  const doctors = await Promise.all(
    items.slice(1).map((d) => getJson<Doctor>(`/doctors/${d.id}`)),
  );
  const cells: { doctorId: string; day: string }[] = [];
  for (let week = 0; week < CELL_WEEK; week++) {
    for (let offset = 0; offset < 5; offset++) {
      const day = addDays(ANCHOR_DAY, 7 * week - 1 + offset);
      for (const d of doctors) {
        if (
          d.working_hours.some(
            (w) =>
              w.weekday === offset + 1 &&
              hours(w.end_time) - hours(w.start_time) >= MIN_HOURS,
          )
        )
          cells.push({ doctorId: d.id, day });
      }
    }
  }
  if (i >= cells.length) {
    throw new Error(`cell ${i} does not exist: there are ${cells.length}`);
  }
  const { doctorId, day } = cells[i];
  const slots = await freeTimes(doctorId, day);
  if (slots.length < 6) {
    throw new Error(`cell ${i}: only ${slots.length} free times on ${day}`);
  }
  return { doctorId, day, slots };
}

export async function freeTimes(
  doctorId: string,
  day: string,
): Promise<string[]> {
  const a = await getJson<{ slots: { starts_at: string }[] }>(
    `/doctors/${doctorId}/availability?date=${day}`,
  );
  return a.slots.map((s) => s.starts_at);
}

/**
 * A time late in the day that this doctor and another doctor (not the first) are both free, and
 * that other doctor. Late, because every test books from the start of a day, so nobody else's
 * booking can take it.
 */
export async function sharedLateTime(
  day: string,
  doctorId: string,
  mine: readonly string[],
): Promise<{ other: string; startsAt: string }> {
  const { items } = await getJson<{ items: { id: string }[] }>("/doctors");
  for (const d of items.slice(1)) {
    if (d.id === doctorId) continue;
    const theirs = new Set(await freeTimes(d.id, day));
    const common = mine.slice(4).filter((t) => theirs.has(t));
    if (common.length > 0)
      return { other: d.id, startsAt: common[common.length - 1] };
  }
  throw new Error(
    `no other doctor shares a late free time with ${doctorId} on ${day}`,
  );
}
