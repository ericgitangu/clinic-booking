import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callApi } from "../src/call";
import * as sdk from "../src/generated";

// Runs against the real API and database (docker compose, migrations and seed), not a stand-in:
// set REAL_API_URL, as the e2e-real CI job does. Skipped in the plain unit run.
//
// What is real here: the API, the database, every response, every error. What is stood in for: only
// the drift cases, where a real response is fetched and then deliberately broken in the transport,
// because a correct server never sends a response that violates its own contract.
const REAL = process.env.REAL_API_URL;
const ID_NONE = "99999999-9999-4999-8999-999999999999";

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });

async function raw(path: string): Promise<unknown> {
  const r = await fetch(`${REAL}${path}`);
  return r.json();
}

describe.skipIf(!REAL)("against the real API", () => {
  let doctorId = "";
  let slots: string[] = [];
  let day = "";
  const logs: string[] = [];

  beforeAll(async () => {
    process.env.API_URL = REAL;
    delete process.env.VERCEL_ENV;
    const doctors = (await raw("/doctors")) as { items: { id: string }[] };
    doctorId = doctors.items[0].id;
    // A day far out (80 to 88 days), so this file never competes with the browser scenarios.
    for (let n = 80; n <= 88 && slots.length < 4; n++) {
      day = addDays(ymd.format(new Date()), n);
      const a = (await raw(
        `/doctors/${doctorId}/availability?date=${day}`,
      )) as { slots: { starts_at: string }[] };
      slots = a.slots.map((s) => s.starts_at);
    }
    expect(slots.length, "a day with free times").toBeGreaterThanOrEqual(4);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });

  it("accepts every real read response", async () => {
    const results = [
      await callApi("listDoctors", (client) =>
        sdk.listDoctorsDoctorsGet({ client }),
      ),
      await callApi("getDoctor", (client) =>
        sdk.getDoctorDoctorsDoctorIdGet({
          client,
          path: { doctor_id: doctorId },
        }),
      ),
      await callApi("availability", (client) =>
        sdk.doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
          client,
          path: { doctor_id: doctorId },
          query: { date: day },
        }),
      ),
      await callApi("health", (client) => sdk.healthHealthGet({ client })),
      await callApi("ready", (client) => sdk.readyReadyGet({ client })),
      await callApi("listProblems", (client) =>
        sdk.listProblemsProblemsGet({ client }),
      ),
      await callApi("getProblem", (client) =>
        sdk.getProblemProblemsSlugGet({ client, path: { slug: "slot-taken" } }),
      ),
    ];
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("returns typed problems for the errors the real API produces", async () => {
    const a = await callApi("getDoctor", (client) =>
      sdk.getDoctorDoctorsDoctorIdGet({ client, path: { doctor_id: ID_NONE } }),
    );
    expect(a).toMatchObject({
      ok: false,
      kind: "problem",
      status: 404,
      code: "DOCTOR_NOT_FOUND",
    });

    const b = await callApi("getAppointment", (client) =>
      sdk.getAppointmentAppointmentsAppointmentIdGet({
        client,
        path: { appointment_id: ID_NONE },
      }),
    );
    expect(b).toMatchObject({
      ok: false,
      kind: "problem",
      status: 404,
      code: "APPOINTMENT_NOT_FOUND",
    });

    const far = await callApi("availability", (client) =>
      sdk.doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
        client,
        path: { doctor_id: doctorId },
        query: { date: addDays(ymd.format(new Date()), 400) },
      }),
    );
    expect(far).toMatchObject({
      ok: false,
      kind: "problem",
      status: 422,
      code: "DATE_OUT_OF_RANGE",
    });
  });

  it("books, refuses a double booking, cancels, refuses a second cancel and a reschedule of a cancelled one", async () => {
    const phone = `+2547${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, "0")}`;
    const p1 = await callApi("postPatient", (client) =>
      sdk.postPatientPatientsPost({
        client,
        body: { full_name: "Real Path One", phone },
      }),
    );
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;

    // the same phone again: the real API says so with a typed problem
    const dup = await callApi("postPatient", (client) =>
      sdk.postPatientPatientsPost({
        client,
        body: { full_name: "Real Path Dup", phone },
      }),
    );
    expect(dup).toMatchObject({
      ok: false,
      kind: "problem",
      status: 409,
      code: "PATIENT_PHONE_EXISTS",
    });

    const p2 = await callApi("postPatient", (client) =>
      sdk.postPatientPatientsPost({
        client,
        body: { full_name: "Real Path Two" },
      }),
    );
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;

    const booked = await callApi("createAppointment", (client) =>
      sdk.createAppointmentAppointmentsPost({
        client,
        body: {
          doctor_id: doctorId,
          patient_id: p1.data.id,
          starts_at: slots[0],
        },
      }),
    );
    expect(booked).toMatchObject({ ok: true, status: 201 });
    if (!booked.ok) return;

    const taken = await callApi("createAppointment", (client) =>
      sdk.createAppointmentAppointmentsPost({
        client,
        body: {
          doctor_id: doctorId,
          patient_id: p2.data.id,
          starts_at: slots[0],
        },
      }),
    );
    expect(taken).toMatchObject({
      ok: false,
      kind: "problem",
      status: 409,
      code: "SLOT_TAKEN",
    });

    const past = await callApi("createAppointment", (client) =>
      sdk.createAppointmentAppointmentsPost({
        client,
        body: {
          doctor_id: doctorId,
          patient_id: p2.data.id,
          starts_at: "2000-01-01T09:00:00+03:00",
        },
      }),
    );
    expect(past).toMatchObject({
      ok: false,
      kind: "problem",
      code: "SLOT_IN_PAST",
    });

    const mine = await callApi("patientAppointments", (client) =>
      sdk.patientAppointmentsPatientsPatientIdAppointmentsGet({
        client,
        path: { patient_id: p1.data.id },
      }),
    );
    expect(mine.ok && mine.data.items.map((i) => i.id)).toContain(
      booked.data.id,
    );

    const moved = await callApi("rescheduleAppointment", (client) =>
      sdk.rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch({
        client,
        path: { appointment_id: booked.data.id },
        body: { starts_at: slots[2] },
      }),
    );
    expect(moved.ok && moved.data.starts_at.slice(0, 16)).toBe(
      slots[2].slice(0, 16),
    );

    const cancelled = await callApi("cancelAppointment", (client) =>
      sdk.cancelAppointmentAppointmentsAppointmentIdCancelPatch({
        client,
        path: { appointment_id: booked.data.id },
        body: { reason: "real path cleanup" },
      }),
    );
    expect(cancelled.ok && cancelled.data.status).toBe("cancelled");

    const again = await callApi("cancelAppointment", (client) =>
      sdk.cancelAppointmentAppointmentsAppointmentIdCancelPatch({
        client,
        path: { appointment_id: booked.data.id },
        body: { reason: "second time" },
      }),
    );
    expect(again).toMatchObject({
      ok: false,
      kind: "problem",
      status: 409,
      code: "APPOINTMENT_ALREADY_CANCELLED",
    });

    const afterCancel = await callApi("rescheduleAppointment", (client) =>
      sdk.rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch({
        client,
        path: { appointment_id: booked.data.id },
        body: { starts_at: slots[3] },
      }),
    );
    expect(afterCancel).toMatchObject({
      ok: false,
      kind: "problem",
      status: 409,
    });
  });

  it("refuses an invalid request without sending it", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await callApi("postPatient", (client) =>
      sdk.postPatientPatientsPost({
        client,
        body: { full_name: "A", phone: "0712" },
      }),
    );
    expect(r).toMatchObject({
      ok: false,
      kind: "invalid_request",
      status: 422,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("flags a real response that is broken in transit as drift (the stood-in part)", async () => {
    vi.spyOn(console, "error").mockImplementation(
      (m: string) => void logs.push(String(m)),
    );
    const real = globalThis.fetch;
    // The real server answers; only the body is damaged on the way back.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      return new Response(
        JSON.stringify({ ...(await res.json()), id: 12345 }),
        { status: res.status, headers: res.headers },
      );
    });
    const r = await callApi("getDoctor", (client) =>
      sdk.getDoctorDoctorsDoctorIdGet({
        client,
        path: { doctor_id: doctorId },
      }),
    );
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
    expect(logs.join("\n")).toContain("contract_violation");
  });
});
