// Prepares the real database through the real API before any test runs:
//  - staff_access rows for an admin, a viewer and a revoked user, made by the owner through the
//    same access endpoints the Access page uses (so the audit rows exist too);
//  - a dozen booked appointments with real histories: one rescheduled, one cancelled.
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";

interface Doctor {
  id: string;
}
interface Slot {
  starts_at: string;
}
interface Appointment {
  id: string;
}

const owner = { email: OWNER, role: "owner" };

async function grant(email: string, role: "admin" | "viewer") {
  const res = await internal("POST", "/internal/admin/access", owner, {
    email,
    role,
  });
  // 409: the row is already active from an earlier run.
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`could not grant ${role} to ${email}: ${res.status}`);
  }
}

async function seedStaff() {
  await grant(EMAIL.admin, "admin");
  await grant(EMAIL.viewer, "viewer");
  await grant(EMAIL.revoked, "viewer");
  const path = `/internal/admin/access/${encodeURIComponent(EMAIL.revoked)}`;
  const res = await internal("DELETE", path, owner);
  // 404: already revoked by an earlier run.
  if (res.status !== 200 && res.status !== 404) {
    throw new Error(`could not revoke ${EMAIL.revoked}: ${res.status}`);
  }
}

async function seedAppointments() {
  const doctors = await publicApi<{ items: Doctor[] }>("GET", "/doctors");
  const doctor = doctors.body.items[0];
  const stamp = Date.now();
  const made: { id: string; second: string }[] = [];
  for (let ahead = 3; made.length < 12 && ahead < 80; ahead++) {
    const date = new Date(Date.now() + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const avail = await publicApi<{ slots: Slot[] }>(
      "GET",
      `/doctors/${doctor.id}/availability?date=${date}`,
    );
    const [first, second] = avail.body.slots;
    if (!first || !second) continue;
    const phone = `+2547${String(stamp + made.length).slice(-8)}`;
    const patient = await publicApi<{ id: string }>("POST", "/patients", {
      full_name: `E2E Patient ${String(made.length + 1).padStart(2, "0")}`,
      phone,
    });
    const booked = await publicApi<Appointment>("POST", "/appointments", {
      doctor_id: doctor.id,
      patient_id: patient.body.id,
      starts_at: first.starts_at,
    });
    if (booked.status === 201)
      made.push({ id: booked.body.id, second: second.starts_at });
  }
  if (made.length < 12)
    throw new Error(`only booked ${made.length} appointments`);

  const moved = await publicApi(
    "PATCH",
    `/appointments/${made[0].id}/reschedule`,
    {
      starts_at: made[0].second,
    },
  );
  if (moved.status !== 200)
    throw new Error(`reschedule failed: ${moved.status}`);
  const cancelled = await publicApi(
    "PATCH",
    `/appointments/${made[1].id}/cancel`,
    {
      reason: "patient called to cancel",
    },
  );
  if (cancelled.status !== 200)
    throw new Error(`cancel failed: ${cancelled.status}`);

  return {
    doctorId: doctor.id,
    rescheduled: made[0].id,
    cancelled: made[1].id,
    free: made.slice(2).map((m) => m.id),
  };
}

export default async function globalSetup() {
  await seedStaff();
  process.env.E2E_STATE = JSON.stringify(await seedAppointments());
}
