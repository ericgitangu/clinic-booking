import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callApi, type ApiResult } from "../src/call";
import * as sdk from "../src/generated";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const T = "2026-10-20T09:00:00+03:00";
const NOW = "2026-10-17T08:00:00Z";

const appointment = {
  id: ID,
  doctor_id: ID,
  patient_id: ID2,
  starts_at: T,
  ends_at: "2026-10-20T09:30:00+03:00",
  status: "booked",
  cancellation_reason: null,
  cancelled_at: null,
  created_at: NOW,
  updated_at: NOW,
};
const doctor = {
  id: ID,
  full_name: "Dr A",
  specialty: "GP",
  clinic: { id: ID2, name: "Clinic", timezone: "Africa/Nairobi" },
  working_hours: [{ weekday: 1, start_time: "08:00:00", end_time: "12:00:00" }],
};
const problem = (code: string, status: number) => ({
  type: `https://example.test/problems/${code}`,
  title: code,
  status,
  detail: "d",
  instance: "/x",
  code,
  request_id: ID2,
});

type Op = {
  name: string;
  run: Parameters<typeof callApi>[1];
  ok: { status: number; body: unknown };
  // an error status the operation documents
  err: { status: number; code: string };
  // arguments the contract refuses; absent when the operation takes no input
  bad?: Parameters<typeof callApi>[1];
};
const c = (client: Parameters<Op["run"]>[0]) => client;

const OPS: Op[] = [
  {
    name: "createAppointment",
    run: (client) =>
      sdk.createAppointmentAppointmentsPost({
        client: c(client),
        body: { doctor_id: ID, patient_id: ID2, starts_at: T },
      }),
    ok: { status: 201, body: appointment },
    err: { status: 409, code: "SLOT_TAKEN" },
    bad: (client) =>
      sdk.createAppointmentAppointmentsPost({
        client: c(client),
        body: { doctor_id: "nope", patient_id: ID2, starts_at: "tomorrow" },
      }),
  },
  {
    name: "getAppointment",
    run: (client) =>
      sdk.getAppointmentAppointmentsAppointmentIdGet({
        client: c(client),
        path: { appointment_id: ID },
      }),
    ok: { status: 200, body: appointment },
    err: { status: 404, code: "APPOINTMENT_NOT_FOUND" },
    bad: (client) =>
      sdk.getAppointmentAppointmentsAppointmentIdGet({
        client: c(client),
        path: { appointment_id: "nope" },
      }),
  },
  {
    name: "cancelAppointment",
    run: (client) =>
      sdk.cancelAppointmentAppointmentsAppointmentIdCancelPatch({
        client: c(client),
        path: { appointment_id: ID },
        body: { reason: "plans changed" },
      }),
    ok: {
      status: 200,
      body: {
        ...appointment,
        status: "cancelled",
        cancellation_reason: "plans changed",
        cancelled_at: NOW,
      },
    },
    err: { status: 409, code: "APPOINTMENT_ALREADY_CANCELLED" },
    bad: (client) =>
      sdk.cancelAppointmentAppointmentsAppointmentIdCancelPatch({
        client: c(client),
        path: { appointment_id: ID },
        body: { reason: "x" },
      }),
  },
  {
    name: "rescheduleAppointment",
    run: (client) =>
      sdk.rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch({
        client: c(client),
        path: { appointment_id: ID },
        body: { starts_at: T },
      }),
    ok: { status: 200, body: appointment },
    err: { status: 409, code: "SLOT_TAKEN" },
    bad: (client) =>
      sdk.rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch({
        client: c(client),
        path: { appointment_id: ID },
        body: { starts_at: "soon" },
      }),
  },
  {
    name: "listDoctors",
    run: (client) => sdk.listDoctorsDoctorsGet({ client: c(client) }),
    ok: { status: 200, body: { items: [doctor] } },
    err: { status: 503, code: "DB_UNAVAILABLE" },
  },
  {
    name: "getDoctor",
    run: (client) =>
      sdk.getDoctorDoctorsDoctorIdGet({
        client: c(client),
        path: { doctor_id: ID },
      }),
    ok: { status: 200, body: doctor },
    err: { status: 404, code: "DOCTOR_NOT_FOUND" },
    bad: (client) =>
      sdk.getDoctorDoctorsDoctorIdGet({
        client: c(client),
        path: { doctor_id: "nope" },
      }),
  },
  {
    name: "doctorAvailability",
    run: (client) =>
      sdk.doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
        client: c(client),
        path: { doctor_id: ID },
        query: { date: "2026-10-20" },
      }),
    ok: {
      status: 200,
      body: {
        doctor_id: ID,
        date: "2026-10-20",
        timezone: "Africa/Nairobi",
        slot_minutes: 30,
        slots: [{ starts_at: T, ends_at: "2026-10-20T09:30:00+03:00" }],
      },
    },
    err: { status: 404, code: "DOCTOR_NOT_FOUND" },
    bad: (client) =>
      sdk.doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
        client: c(client),
        path: { doctor_id: "nope" },
        query: { date: "2026-10-20" },
      }),
  },
  {
    name: "health",
    run: (client) => sdk.healthHealthGet({ client: c(client) }),
    ok: { status: 200, body: { status: "ok" } },
    err: { status: 503, code: "DB_UNAVAILABLE" },
  },
  {
    name: "postPatient",
    run: (client) =>
      sdk.postPatientPatientsPost({
        client: c(client),
        body: { full_name: "Amina Wanjiku", phone: "+254712345678" },
      }),
    ok: {
      status: 201,
      body: {
        id: ID,
        full_name: "Amina Wanjiku",
        phone: "+254712345678",
        email: null,
        created_at: NOW,
      },
    },
    err: { status: 409, code: "PATIENT_PHONE_EXISTS" },
    bad: (client) =>
      sdk.postPatientPatientsPost({
        client: c(client),
        body: { full_name: "A", phone: "0712" },
      }),
  },
  {
    name: "patientAppointments",
    run: (client) =>
      sdk.patientAppointmentsPatientsPatientIdAppointmentsGet({
        client: c(client),
        path: { patient_id: ID },
      }),
    ok: {
      status: 200,
      body: {
        items: [
          {
            ...appointment,
            doctor: { id: ID, full_name: "Dr A", specialty: "GP" },
          },
        ],
        next_cursor: null,
      },
    },
    err: { status: 404, code: "PATIENT_NOT_FOUND" },
    bad: (client) =>
      sdk.patientAppointmentsPatientsPatientIdAppointmentsGet({
        client: c(client),
        path: { patient_id: "nope" },
      }),
  },
  {
    name: "listProblems",
    run: (client) => sdk.listProblemsProblemsGet({ client: c(client) }),
    ok: {
      status: 200,
      body: [
        {
          slug: "slot-taken",
          title: "Slot taken",
          status: 409,
          code: "SLOT_TAKEN",
          description: "d",
        },
      ],
    },
    err: { status: 503, code: "DB_UNAVAILABLE" },
  },
  {
    name: "getProblem",
    run: (client) =>
      sdk.getProblemProblemsSlugGet({
        client: c(client),
        path: { slug: "slot-taken" },
      }),
    ok: {
      status: 200,
      body: {
        slug: "slot-taken",
        title: "Slot taken",
        status: 409,
        code: "SLOT_TAKEN",
        description: "d",
      },
    },
    err: { status: 404, code: "PROBLEM_NOT_FOUND" },
  },
  {
    name: "ready",
    run: (client) => sdk.readyReadyGet({ client: c(client) }),
    ok: { status: 200, body: { status: "ok" } },
    err: { status: 503, code: "DB_UNAVAILABLE" },
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let logs: string[];
const reply = (status: number, body: unknown, type = "application/json") =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": type },
    }),
  );

beforeEach(() => {
  process.env.API_URL = "http://api.test";
  delete process.env.VERCEL_ENV;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logs = [];
  vi.spyOn(console, "error").mockImplementation(
    (m: string) => void logs.push(String(m)),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const events = () =>
  logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.message === "contract_violation");

describe.each(OPS)("$name", (op) => {
  it("returns the data for a valid response", async () => {
    reply(op.ok.status, op.ok.body);
    const r = await callApi(op.name, op.run);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe(op.ok.status);
  });

  it("returns a typed problem for a valid problem+json", async () => {
    reply(
      op.err.status,
      problem(op.err.code, op.err.status),
      "application/problem+json",
    );
    const r = await callApi(op.name, op.run);
    expect(r).toMatchObject({
      ok: false,
      kind: "problem",
      status: op.err.status,
      code: op.err.code,
    });
  });

  it("treats a response that does not match the contract as drift: logged, generic", async () => {
    reply(op.ok.status, { unexpected: "shape", secret: "VALUE-MUST-NOT-LEAK" });
    const r = (await callApi(op.name, op.run)) as ApiResult<unknown>;
    expect(r).toMatchObject({
      ok: false,
      kind: "contract_violation",
      code: "CONTRACT_VIOLATION",
    });
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      operation: op.name,
      status: op.ok.status,
      where: "response",
    });
    expect(logs.join("\n")).not.toContain("VALUE-MUST-NOT-LEAK");
  });

  it("treats a problem that does not match the contract as drift", async () => {
    reply(
      op.err.status,
      { ...problem(op.err.code, op.err.status), code: "NOT_A_REAL_CODE" },
      "application/problem+json",
    );
    const r = await callApi(op.name, op.run);
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
    expect(events()[0]).toMatchObject({
      operation: op.name,
      status: op.err.status,
      where: "problem",
    });
  });

  it("treats an error status with a body that is not JSON as drift", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
    const r = await callApi(op.name, op.run);
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
  });

  if (op.bad) {
    it("refuses a request the contract does not allow, without calling the API", async () => {
      const r = await callApi(op.name, op.bad!);
      expect(r).toMatchObject({
        ok: false,
        kind: "invalid_request",
        status: 422,
        code: "VALIDATION_ERROR",
      });
      if (!r.ok && r.kind === "invalid_request")
        expect(r.issues.length).toBeGreaterThan(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe("details", () => {
  it("names the failing fields and zod issue codes only, never the values", async () => {
    const r = await callApi("postPatient", (client) =>
      sdk.postPatientPatientsPost({
        client,
        body: { full_name: "A", phone: "SECRET-PHONE" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.kind === "invalid_request") {
      expect(r.issues.map((i) => i.field).sort()).toEqual([
        "full_name",
        "phone",
      ]);
      expect(JSON.stringify(r)).not.toContain("SECRET-PHONE");
    }
  });

  it("accepts the Nairobi offset the API sends on times", async () => {
    reply(200, OPS[1].ok.body);
    const r = await callApi("getAppointment", OPS[1].run);
    expect(r.ok).toBe(true);
  });

  it("rejects a status value the contract does not list", async () => {
    reply(200, { ...appointment, status: "canceled" });
    const r = await callApi("getAppointment", OPS[1].run);
    expect(r).toMatchObject({ ok: false, kind: "contract_violation" });
    expect(events()[0].paths).toBe("status");
  });

  it("reports an unreachable API without a contract event", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const r = await callApi("listDoctors", OPS[4].run);
    expect(r).toMatchObject({
      ok: false,
      kind: "unavailable",
      code: "UPSTREAM_UNREACHABLE",
    });
    expect(events()).toHaveLength(0);
  });

  it("says so when the API address is not configured", async () => {
    delete process.env.API_URL;
    const r = await callApi("listDoctors", OPS[4].run);
    expect(r).toMatchObject({
      ok: false,
      kind: "unavailable",
      code: "API_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the request to the configured base URL", async () => {
    reply(200, OPS[4].ok.body);
    await callApi("listDoctors", OPS[4].run);
    expect((fetchMock.mock.calls[0][0] as Request).url).toBe(
      "http://api.test/doctors",
    );
  });
});
