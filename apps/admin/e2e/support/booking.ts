// Books one more appointment straight through the public API, the way a patient's booking does.
// It does not touch the admin app, so the admin app's cached metrics do not know about it.
import { addDays } from "../../src/lib/clinic-time";
import { publicApi } from "./stack";

interface Slot {
  starts_at: string;
}

export async function bookOneStraightThroughTheApi(
  opts: { email?: string; name?: string } = {},
): Promise<string> {
  const doctors = await publicApi<{ items: { id: string }[] }>(
    "GET",
    "/doctors",
  );
  const doctor = doctors.body.items[0];
  // Far enough ahead to stay clear of the days the seeding and the other specs use, and the last
  // free time of the day, which they never pick.
  for (let ahead = 30; ahead < 120; ahead++) {
    const date = new Date(Date.now() + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const avail = await publicApi<{ slots: Slot[] }>(
      "GET",
      `/doctors/${doctor.id}/availability?date=${date}`,
    );
    const slot = avail.body.slots.at(-1);
    if (!slot) continue;
    const patient = await publicApi<{ id: string }>("POST", "/patients", {
      full_name: opts.name ?? "E2E Cache Patient",
      phone: `+2547${String(Date.now()).slice(-8)}`,
      ...(opts.email ? { email: opts.email } : {}),
    });
    const booked = await publicApi<{ id: string }>("POST", "/appointments", {
      doctor_id: doctor.id,
      patient_id: patient.body.id,
      starts_at: slot.starts_at,
    });
    if (booked.status === 201) return booked.body.id;
  }
  throw new Error("no free time to book");
}

/**
 * A free time on the first day after `afterDate` that has at least `minSlots` of them, looking up
 * to a week ahead. The doctor booked above works Monday to Friday, so the day after a Friday has
 * nothing; a week always reaches a working day. Returns the second slot of that day, or undefined
 * when the week is empty.
 */
export async function nextDayWithFreeTime(
  doctorId: string,
  afterDate: string,
  minSlots = 2,
): Promise<Slot | undefined> {
  for (let n = 1; n <= 7; n++) {
    const avail = await publicApi<{ slots: Slot[] }>(
      "GET",
      `/doctors/${doctorId}/availability?date=${addDays(afterDate, n)}`,
    );
    if (avail.body.slots.length >= minSlots) return avail.body.slots[1];
  }
  return undefined;
}
