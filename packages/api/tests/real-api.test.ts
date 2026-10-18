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
  // Appointments a test made on behalf of a signed-in caller, cancelled after the test whatever
  // its outcome.
  const held: {
    caller: {
      sub: string;
      email: string;
      role: string;
      emailVerified: boolean;
    };
    id: string;
  }[] = [];

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

  afterEach(async () => {
    vi.restoreAllMocks();
    logs.length = 0;
    for (const { caller, id } of held.splice(0)) {
      const done = await callApi(
        "cancelMine",
        (client) =>
          sdk.cancelMineInternalMeAppointmentsAppointmentIdCancelPatch({
            client,
            path: { appointment_id: id },
            body: { reason: "test cleanup" },
          }),
        { caller },
      );
      expect(done.ok && done.data.status, "cleanup cancel").toBe("cancelled");
    }
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

  it("sends the Idempotency-Key to the API: a retry returns the same appointment, a different time is refused", async () => {
    expect(
      process.env.INTERNAL_SIGNING_KEY,
      "INTERNAL_SIGNING_KEY",
    ).toBeTruthy();
    const suffix = Math.random().toString(36).slice(2, 10);
    const caller = {
      sub: `idem-${suffix}`,
      email: `idem-${suffix}@example.test`,
      role: "patient",
      emailVerified: true,
    };
    const linked = await callApi(
      "linkAccount",
      (client) =>
        sdk.linkAccountInternalAccountsLinkPost({
          client,
          body: { full_name: "Idempotent Person" },
        }),
      { caller },
    );
    expect(linked.ok).toBe(true);

    const key = `real-${suffix}`;
    const book = (startsAt: string, idempotencyKey: string) =>
      callApi(
        "bookMine",
        (client) =>
          sdk.bookMineInternalMeAppointmentsPost({
            client,
            body: { doctor_id: doctorId, starts_at: startsAt },
            headers: { "Idempotency-Key": idempotencyKey },
          }),
        { caller },
      );

    const first = await book(slots[1], key);
    // Registered for cleanup before anything is asserted, so a failed assertion below cannot leave
    // the time booked for the tests that follow (afterEach cancels it).
    if (first.ok) held.push({ caller, id: first.data.id });
    expect(first).toMatchObject({ ok: true, status: 201 });
    if (!first.ok) return;

    // The response was "lost": the same attempt is sent again with the same key.
    const replay = await book(slots[1], key);
    expect(replay).toMatchObject({ ok: true, status: 201 });
    expect(replay.ok && replay.data.id).toBe(first.data.id);

    // Without the key the same request is a conflict with the patient's own booking, which is
    // what the key prevents.
    const keyless = await callApi(
      "bookMine",
      (client) =>
        sdk.bookMineInternalMeAppointmentsPost({
          client,
          body: { doctor_id: doctorId, starts_at: slots[1] },
        }),
      { caller },
    );
    expect(keyless).toMatchObject({ ok: false, kind: "problem", status: 409 });

    // The same key for a different time is a different request.
    const reused = await book(slots[3], key);
    expect(reused).toMatchObject({
      ok: false,
      kind: "problem",
      status: 422,
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    // A malformed key is refused by the client before any call: `invalid_request` is produced only
    // when the generated schema rejects the request and there is no response at all (a key that
    // reached the API would come back as a `problem`).
    for (const bad of ["", "has space", "tab\there", "x".repeat(256)]) {
      const malformed = await book(slots[1], bad);
      expect(malformed).toMatchObject({
        ok: false,
        kind: "invalid_request",
        status: 422,
      });
      expect(
        malformed.ok === false &&
          malformed.kind === "invalid_request" &&
          malformed.issues.map((i) => i.field),
      ).toContain("Idempotency-Key");
    }
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

  it("links a sign-in to one patient, and a patient reaches only their own appointments", async () => {
    // Needs the same signing key the API was started with (the e2e-real job and make e2e set it).
    expect(
      process.env.INTERNAL_SIGNING_KEY,
      "INTERNAL_SIGNING_KEY",
    ).toBeTruthy();
    const tag = Math.random().toString(36).slice(2, 10);
    const alice = {
      sub: `sub-${tag}-a`,
      email: `a-${tag}@clinic.example`,
      role: "patient",
      emailVerified: true,
    };
    const bob = {
      sub: `sub-${tag}-b`,
      email: `b-${tag}@clinic.example`,
      role: "patient",
      emailVerified: true,
    };

    // Without an assertion the API refuses, and says so with a typed problem.
    const anon = await callApi("myAppointments", (client) =>
      sdk.myAppointmentsInternalMeAppointmentsGet({ client }),
    );
    expect(anon).toMatchObject({
      ok: false,
      kind: "problem",
      status: 401,
      code: "UNAUTHENTICATED",
    });

    // An email Google has not verified is refused on every patient route, with a typed problem.
    const unverified = {
      ...alice,
      sub: `${alice.sub}-u`,
      emailVerified: false,
    };
    const refused = await callApi(
      "linkAccount",
      (client) =>
        sdk.linkAccountInternalAccountsLinkPost({
          client,
          body: { full_name: "Nope Person" },
        }),
      { caller: unverified },
    );
    expect(refused).toMatchObject({
      ok: false,
      kind: "problem",
      status: 403,
      code: "FORBIDDEN",
    });

    const before = await callApi(
      "myAppointments",
      (client) => sdk.myAppointmentsInternalMeAppointmentsGet({ client }),
      { caller: alice },
    );
    expect(before).toMatchObject({
      ok: false,
      kind: "problem",
      status: 404,
      code: "PATIENT_NOT_FOUND",
    });

    const first = await callApi(
      "linkAccount",
      (client) =>
        sdk.linkAccountInternalAccountsLinkPost({
          client,
          body: { full_name: "Alice Real" },
        }),
      { caller: alice },
    );
    expect(first).toMatchObject({ ok: true, status: 201 });
    expect(first.ok && first.data.created).toBe(true);
    const again = await callApi(
      "linkAccount",
      (client) =>
        sdk.linkAccountInternalAccountsLinkPost({
          client,
          body: { full_name: "Alice Other Name" },
        }),
      { caller: alice },
    );
    expect(again).toMatchObject({ ok: true, status: 200 });
    expect(again.ok && again.data.created).toBe(false);
    expect(again.ok && first.ok && again.data.patient_id).toBe(
      first.ok && first.data.patient_id,
    );
    await callApi(
      "linkAccount",
      (client) =>
        sdk.linkAccountInternalAccountsLinkPost({
          client,
          body: { full_name: "Bob Real" },
        }),
      { caller: bob },
    );

    const booked = await callApi(
      "bookMine",
      (client) =>
        sdk.bookMineInternalMeAppointmentsPost({
          client,
          body: { doctor_id: doctorId, starts_at: slots[1] },
        }),
      { caller: alice },
    );
    expect(booked).toMatchObject({ ok: true, status: 201 });
    if (!booked.ok) return;
    expect(first.ok && booked.data.patient_id).toBe(
      first.ok && first.data.patient_id,
    );

    const mine = await callApi(
      "myAppointments",
      (client) => sdk.myAppointmentsInternalMeAppointmentsGet({ client }),
      { caller: alice },
    );
    expect(mine.ok && mine.data.items.map((i) => i.id)).toContain(
      booked.data.id,
    );
    const theirs = await callApi(
      "myAppointments",
      (client) => sdk.myAppointmentsInternalMeAppointmentsGet({ client }),
      { caller: bob },
    );
    expect(theirs.ok && theirs.data.items).toEqual([]);

    // Bob asks for Alice's appointment: not found, exactly as for an id that never existed.
    const peek = await callApi(
      "myAppointment",
      (client) =>
        sdk.myAppointmentInternalMeAppointmentsAppointmentIdGet({
          client,
          path: { appointment_id: booked.data.id },
        }),
      { caller: bob },
    );
    expect(peek).toMatchObject({
      ok: false,
      kind: "problem",
      status: 404,
      code: "APPOINTMENT_NOT_FOUND",
    });
    const cancelOthers = await callApi(
      "cancelMine",
      (client) =>
        sdk.cancelMineInternalMeAppointmentsAppointmentIdCancelPatch({
          client,
          path: { appointment_id: booked.data.id },
          body: { reason: "not mine to cancel" },
        }),
      { caller: bob },
    );
    expect(cancelOthers).toMatchObject({
      ok: false,
      kind: "problem",
      status: 404,
      code: "APPOINTMENT_NOT_FOUND",
    });

    const cancelled = await callApi(
      "cancelMine",
      (client) =>
        sdk.cancelMineInternalMeAppointmentsAppointmentIdCancelPatch({
          client,
          path: { appointment_id: booked.data.id },
          body: { reason: "real path cleanup" },
        }),
      { caller: alice },
    );
    expect(cancelled.ok && cancelled.data.status).toBe("cancelled");
  });

  // The stood-in part, and the only one: the real server answers, then the body is damaged on the way
  // back, because a correct server never sends a response that violates its own contract.
  const damaged = (
    mutate: (body: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const real = globalThis.fetch;
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const res = await real(input, init);
        const body = (await res.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify(
            Array.isArray(body) ? [{ broken: true }] : mutate(body),
          ),
          {
            status: res.status,
            headers: res.headers,
          },
        );
      });
  };

  it("flags a real success response damaged in transit, for every kind of read", async () => {
    vi.spyOn(console, "error").mockImplementation(
      (m: string) => void logs.push(String(m)),
    );
    damaged((b) => ({
      ...b,
      id: 12345,
      items: "not a list",
      slots: "none",
      status: 42,
    }));
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
      await callApi("ready", (client) => sdk.readyReadyGet({ client })),
      await callApi("listProblems", (client) =>
        sdk.listProblemsProblemsGet({ client }),
      ),
    ];
    for (const r of results)
      expect(r).toMatchObject({
        ok: false,
        kind: "contract_violation",
        code: "CONTRACT_VIOLATION",
      });
    expect(logs.filter((l) => l.includes("contract_violation"))).toHaveLength(
      results.length,
    );
    expect(logs.join("\n")).not.toContain("12345");
  });

  it("flags a real problem damaged in transit (a code the contract does not list)", async () => {
    vi.spyOn(console, "error").mockImplementation(
      (m: string) => void logs.push(String(m)),
    );
    damaged((b) => ({ ...b, code: "NOT_A_REAL_CODE" }));
    const r = await callApi("getDoctor", (client) =>
      sdk.getDoctorDoctorsDoctorIdGet({ client, path: { doctor_id: ID_NONE } }),
    );
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
    expect(logs.join("\n")).toContain('"where":"problem"');
  });

  it("flags a real problem that lost a required field", async () => {
    vi.spyOn(console, "error").mockImplementation(
      (m: string) => void logs.push(String(m)),
    );
    damaged((b) => {
      const rest = { ...b };
      delete rest.request_id;
      return rest;
    });
    const r = await callApi("getAppointment", (client) =>
      sdk.getAppointmentAppointmentsAppointmentIdGet({
        client,
        path: { appointment_id: ID_NONE },
      }),
    );
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
  });
});
