// Booking and rescheduling through the public API, as a patient's own browser would, for the
// scenarios that need a live event to appear.
import { publicApi } from "./stack";
import { expect, seeded } from "./fixtures";

interface Slot {
  starts_at: string;
}

let counter = 0;

/** A new patient with a recognisable name and a booking in the next weeks. */
export async function book(name: string) {
  const { doctorId } = seeded();
  const phone = `+2547${String(Date.now() + counter++).slice(-8)}`;
  const patient = await publicApi<{ id: string }>("POST", "/patients", {
    full_name: name,
    phone,
  });
  expect(patient.status).toBe(201);
  const start = 3 + Math.floor(Math.random() * 40);
  for (let ahead = start; ahead < 85; ahead++) {
    const date = new Date(Date.now() + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const avail = await publicApi<{ slots: Slot[] }>(
      "GET",
      `/doctors/${doctorId}/availability?date=${date}`,
    );
    const slots = avail.body.slots;
    if (slots.length < 2) continue;
    const slot = slots[Math.floor(Math.random() * slots.length)];
    const res = await publicApi<{ id: string }>("POST", "/appointments", {
      doctor_id: doctorId,
      patient_id: patient.body.id,
      starts_at: slot.starts_at,
    });
    if (res.status === 201)
      return { id: res.body.id, name, date, startsAt: slot.starts_at };
  }
  throw new Error("no free slot to book");
}

/** The patient moves their own booking to another free time the same day. */
export async function patientReschedules(made: {
  id: string;
  date: string;
  startsAt: string;
}) {
  const { doctorId } = seeded();
  const avail = await publicApi<{ slots: Slot[] }>(
    "GET",
    `/doctors/${doctorId}/availability?date=${made.date}`,
  );
  const to = avail.body.slots.find(
    (s) => Date.parse(s.starts_at) !== Date.parse(made.startsAt),
  );
  if (!to) throw new Error("no second free slot that day");
  const moved = await publicApi(
    "PATCH",
    `/appointments/${made.id}/reschedule`,
    { starts_at: to.starts_at },
  );
  expect(moved.status).toBe(200);
}
