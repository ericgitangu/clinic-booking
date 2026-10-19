#!/usr/bin/env node
// Builds the reviewer collection in docs/api/ from contracts/openapi.json.
//
//   node scripts/api_collection.mjs          write the collection and the two environments
//   node scripts/api_collection.mjs --check  fail if the committed files differ from a fresh build
//
// Each request names the contract operation it exercises. The method, path, summary and
// description come from the contract, and every response body is checked against the response
// schema the contract declares for that status, so a contract change shows up here as a diff (and
// as a failing --check in CI). Every public operation must appear at least once or be listed in
// NOT_IN_JOURNEY with a reason. No dependencies: Node's standard library only.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = JSON.parse(readFileSync(join(ROOT, "contracts/openapi.json"), "utf8"));
const OUT = join(ROOT, "docs/api");

// The lead time this deployment enforces (BOOKING_MIN_LEAD_MINUTES), as the contract states it. The
// API fills it into the availability description when it builds the document, so a different value
// rebuilds the collection with that value.
const LEAD = Number(/within (\d+) minutes/.exec(SPEC.paths["/doctors/{doctor_id}/availability"]?.get?.description ?? "")?.[1]);
if (!Number.isInteger(LEAD) || LEAD < 2) throw new Error("no lead time in the availability description of contracts/openapi.json");
const SOON = Math.floor(LEAD / 2); // minutes ahead for a start that is too soon

// Public operations the journey leaves out on purpose.
const NOT_IN_JOURNEY = {
  "POST /realtime/token/patient":
    "the booking site's live-updates token: it answers only the site's own Origin and needs an Ably key, which the compose stack does not have",
};

// ---- contract helpers --------------------------------------------------------------------

function operation(method, path) {
  const op = SPEC.paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`${method} ${path} is not in contracts/openapi.json`);
  return op;
}

// Inline every $ref so the schema stands alone in a test script. Annotations are dropped
// (title, description, examples) because they only add bytes; formats are dropped because the
// validator inside Postman and newman does not know "uuid" or "email" and would refuse the schema.
function inline(schema, seen = []) {
  if (Array.isArray(schema)) return schema.map((s) => inline(s, seen));
  if (schema === null || typeof schema !== "object") return schema;
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.includes(name)) throw new Error(`recursive schema ${name} cannot be inlined`);
    return inline(SPEC.components.schemas[name], [...seen, name]);
  }
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (["title", "description", "examples", "example", "format", "default"].includes(k)) continue;
    // "properties" maps field names to schemas: keep every name, even "title" or "format".
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, inline(s, seen)])) : inline(v, seen);
  }
  return out;
}

function responseSchema(op, status) {
  const res = op.responses[String(status)];
  if (!res) throw new Error(`${op.operationId} declares no ${status} response`);
  const content = res.content ?? {};
  const json = content["application/json"];
  if (json?.schema) return inline(json.schema);
  // Some problem responses carry only examples; every problem body is the Problem schema.
  if (content["application/problem+json"]) return inline(content["application/problem+json"].schema ?? { $ref: "#/components/schemas/Problem" });
  throw new Error(`${op.operationId} ${status} has no JSON schema`);
}

// ---- script fragments --------------------------------------------------------------------

const js = (strings, ...vals) => String.raw(strings, ...vals);

// Every request's pre-request script starts with this guard. It skips the request when a variable
// it needs is still empty: an earlier step was skipped or failed, soonAppointmentId was not seeded,
// or, for every request other than GET, writeBaseUrl is not set. `needs` is worked out when the
// collection is built: the variables the request and its scripts read, less those its pre-request sets.
//
// The guard is a convenience, not the safety. Requests other than GET are addressed to
// {{writeBaseUrl}}, which the production environment does not define, so a client that ignores
// these scripts sends them to no host at all rather than to production.
const guard = (needs, own) => js`const needs = ${JSON.stringify(needs)};
const missing = needs.filter((name) => !pm.variables.get(name));
if (missing.includes("writeBaseUrl")) {
  console.log("skipped (writes are off; set writeBaseUrl to the API base to run it): " + pm.info.requestName);
  pm.execution.skipRequest();
} else if (missing.length) {
  console.log("skipped (" + missing.join(", ") + " not set): " + pm.info.requestName);
  pm.execution.skipRequest();
}${own ? " else {\n" + own.replace(/^/gm, "  ") + "\n}" : ""}`;

const expectJson = (status) => js`pm.test("status is ${status}", () => pm.response.to.have.status(${status}));
pm.test("content-type is application/json", () => pm.expect(pm.response.headers.get("Content-Type") || "").to.match(/^application\/json/));`;

const expectProblem = (status, code) => js`pm.test("status is ${status}", () => pm.response.to.have.status(${status}));
pm.test("content-type is application/problem+json", () => pm.expect(pm.response.headers.get("Content-Type") || "").to.match(/^application\/problem\+json/));
const problem = pm.response.json();
pm.test("problem code is ${code}", () => pm.expect(problem.code).to.eql("${code}"));
pm.test("problem status matches the response", () => pm.expect(problem.status).to.eql(${status}));
pm.test("problem carries type, title, instance and request_id", () => {
  for (const k of ["type", "title", "instance", "request_id"]) pm.expect(problem[k], k).to.be.a("string").and.not.empty;
});`;

const schemaTest = (schema) => js`const schema = ${JSON.stringify(schema)};
pm.test("body matches the contract schema", () => pm.response.to.have.jsonSchema(schema));`;

// Where a problem lists field errors, the field the request got wrong is among them.
const fieldError = (where, field) => js`pm.test("errors[] names ${where}.${field}", () => {
  const locs = (problem.errors || []).map((e) => (e.loc || []).join("."));
  pm.expect(locs).to.include("${where}.${field}");
});`;

// ---- the journey -------------------------------------------------------------------------
// expect: [status] for a success (body checked against the contract), [status, CODE] for a problem.

const JSON_BODY = (obj) => ({ mode: "raw", raw: JSON.stringify(obj, null, 2), options: { raw: { language: "json" } } });

const FOLDERS = [
  {
    name: "01 Health",
    description: "Liveness, readiness (the API runs `SELECT 1` against Postgres) and the error catalogue.",
    requests: [
      { name: "Liveness", op: ["GET", "/health"], expect: [200], tests: js`pm.test("status is ok", () => pm.expect(pm.response.json().status).to.eql("ok"));` },
      { name: "Readiness", op: ["GET", "/ready"], expect: [200] },
      {
        name: "Error catalogue",
        op: ["GET", "/problems"],
        expect: [200],
        tests: js`const codes = pm.response.json().map((p) => p.code);
pm.test("catalogue lists both one-hour codes", () => pm.expect(codes).to.include.members(["BOOKING_TOO_SOON", "CHANGE_TOO_LATE"]));`,
      },
      {
        name: "Error type document",
        op: ["GET", "/problems/{slug}"],
        path: "/problems/booking-too-soon",
        expect: [200],
        tests: js`pm.test("it documents BOOKING_TOO_SOON as a 422", () => {
  const p = pm.response.json();
  pm.expect([p.code, p.status]).to.eql(["BOOKING_TOO_SOON", 422]);
});`,
      },
    ],
  },
  {
    name: "02 Doctors",
    description: "The seeded doctors. The first one is used for the rest of the run.",
    requests: [
      {
        name: "List doctors",
        op: ["GET", "/doctors"],
        expect: [200],
        tests: js`const items = pm.response.json().items;
pm.test("at least one doctor", () => pm.expect(items).to.be.an("array").that.is.not.empty);
pm.test("every doctor has working hours", () => items.forEach((d) => pm.expect(d.working_hours, d.full_name).to.not.be.empty));
pm.collectionVariables.set("doctorId", items[0].id);`,
      },
      {
        name: "One doctor",
        op: ["GET", "/doctors/{doctor_id}"],
        path: "/doctors/{{doctorId}}",
        expect: [200],
        tests: js`pm.test("it is the doctor asked for", () => pm.expect(pm.response.json().id).to.eql(pm.collectionVariables.get("doctorId")));`,
      },
    ],
  },
  {
    name: "03 Slots",
    description:
      "Free slots for the doctor on a clinic-local day. The pre-request script looks from tomorrow, a day at a time (up to 14), for a day with at least two free slots, so the run never depends on a fixed date. It works when the request is sent on its own too.",
    requests: [
      {
        name: "Free slots for a day",
        op: ["GET", "/doctors/{doctor_id}/availability"],
        path: "/doctors/{{doctorId}}/availability",
        query: [["date", "{{slotDay}}"]],
        prerequest: js`// Asks for one day after another, from tomorrow, until a day has two free slots, then sends this
// request for that day. Dates are UTC dates: the sandbox has no time-zone data, and from tomorrow
// on the UTC date is never earlier than the clinic's local today. pm.sendRequest works for a request
// sent by hand as well as in a collection run.
const base = pm.variables.replaceIn("{{baseUrl}}/doctors/{{doctorId}}/availability?date=");
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
pm.collectionVariables.set("slotDay", day(1));
pm.collectionVariables.set("slotSearch", "none");
const probe = (n) => {
  if (n > 14) return; // none found: slotSearch stays "none" and the tests below fail and say so
  pm.sendRequest(base + day(n), (err, res) => {
    if (!err && res.code === 200 && res.json().slots.length >= 2) {
      pm.collectionVariables.set("slotDay", day(n));
      pm.collectionVariables.set("slotSearch", "found");
    } else probe(n + 1);
  });
};
probe(1);`,
        expect: [200],
        tests: js`const body = pm.response.json();
pm.test("it is the day asked for", () => pm.expect(body.date).to.eql(pm.collectionVariables.get("slotDay")));
pm.test("no slot starts within ${LEAD} minutes", () => {
  // Against the server's clock (the Date header, whole seconds), not this machine's.
  const now = Date.parse(pm.response.headers.get("Date") || "") || Date.now() - 120000;
  const earliest = now + ${LEAD} * 60000 - 2000;
  body.slots.forEach((s) => pm.expect(new Date(s.starts_at).getTime(), s.starts_at).to.be.at.least(earliest));
});
const found = pm.collectionVariables.get("slotSearch") === "found" && body.slots.length >= 2;
pm.test("a day in the next 14 has two free slots (if not, the steps that book are skipped; send this again later)", () => {
  pm.expect(found, "no day from tomorrow to 14 days out has two free slots").to.be.true;
});
pm.collectionVariables.set("slotMinutes", String(body.slot_minutes));
pm.collectionVariables.set("slotStart", found ? body.slots[0].starts_at : "");
pm.collectionVariables.set("slotStartNew", found ? body.slots[1].starts_at : "");`,
      },
    ],
  },
  {
    name: "04 Book with an Idempotency-Key",
    description:
      "Creates a patient and books the first free slot with an Idempotency-Key. Sending the same request again returns the same appointment with `Idempotent-Replayed: true`; the same key with a different time is refused.",
    requests: [
      {
        name: "Create a patient",
        op: ["POST", "/patients"],
        body: { full_name: "Reviewer {{$randomFirstName}}" },
        expect: [201],
        tests: js`pm.collectionVariables.set("patientId", pm.response.json().id);`,
      },
      {
        name: "Book the slot",
        op: ["POST", "/appointments"],
        headers: [["Idempotency-Key", "{{idempotencyKey}}"]],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{patientId}}", starts_at: "{{slotStart}}" },
        prerequest: js`// One key per booking attempt; the replay below reuses it.
pm.collectionVariables.set("idempotencyKey", "review-" + pm.variables.replaceIn("{{$guid}}"));`,
        expect: [201],
        tests: js`const appt = pm.response.json();
pm.test("booked at the slot asked for", () => {
  pm.expect(appt.status).to.eql("booked");
  pm.expect(new Date(appt.starts_at).getTime()).to.eql(new Date(pm.collectionVariables.get("slotStart")).getTime());
  pm.expect(new Date(appt.ends_at) - new Date(appt.starts_at)).to.eql(Number(pm.collectionVariables.get("slotMinutes")) * 60000);
});
pm.test("Location points at the appointment", () => pm.expect(pm.response.headers.get("Location")).to.eql("/appointments/" + appt.id));
pm.test("not marked as a replay", () => pm.expect(pm.response.headers.has("Idempotent-Replayed")).to.be.false);
pm.collectionVariables.set("appointmentId", appt.id);`,
      },
      {
        name: "Replay the same booking",
        op: ["POST", "/appointments"],
        headers: [["Idempotency-Key", "{{idempotencyKey}}"]],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{patientId}}", starts_at: "{{slotStart}}" },
        expect: [201],
        tests: js`pm.test("same appointment returned", () => pm.expect(pm.response.json().id).to.eql(pm.collectionVariables.get("appointmentId")));
pm.test("Idempotent-Replayed: true", () => pm.expect(pm.response.headers.get("Idempotent-Replayed")).to.eql("true"));`,
      },
      {
        name: "Same key, different time",
        op: ["POST", "/appointments"],
        headers: [["Idempotency-Key", "{{idempotencyKey}}"]],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{patientId}}", starts_at: "{{slotStartNew}}" },
        expect: [422, "IDEMPOTENCY_KEY_REUSED"],
      },
      {
        name: "Read the appointment",
        op: ["GET", "/appointments/{appointment_id}"],
        path: "/appointments/{{appointmentId}}",
        expect: [200],
        tests: js`pm.test("it is the booked appointment", () => {
  const a = pm.response.json();
  pm.expect([a.id, a.status]).to.eql([pm.collectionVariables.get("appointmentId"), "booked"]);
});`,
      },
      {
        name: "The patient's appointments",
        op: ["GET", "/patients/{patient_id}/appointments"],
        path: "/patients/{{patientId}}/appointments",
        expect: [200],
        tests: js`const ids = pm.response.json().items.map((a) => a.id);
pm.test("the replay made no second booking", () => pm.expect(ids).to.eql([pm.collectionVariables.get("appointmentId")]));`,
      },
    ],
  },
  {
    name: "05 Double booking",
    description: "A second patient asks for the slot the first one holds. The partial unique index refuses it with 409.",
    requests: [
      {
        name: "Create a second patient",
        op: ["POST", "/patients"],
        body: { full_name: "Reviewer {{$randomFirstName}}" },
        expect: [201],
        tests: js`pm.collectionVariables.set("otherPatientId", pm.response.json().id);`,
      },
      {
        name: "Book the taken slot",
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{slotStart}}" },
        expect: [409, "SLOT_TAKEN"],
      },
    ],
  },
  {
    name: "06 Too soon",
    description:
      `The lead-time rule on a new time: a start under ${LEAD} minutes away is 422 BOOKING_TOO_SOON, for a booking and for a reschedule's new time. The time is computed from now, ${SOON} minutes ahead. ${LEAD} comes from the contract.`,
    requests: [
      {
        name: `Book ${SOON} minutes from now`,
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{soonStart}}" },
        prerequest: js`const t = new Date(Date.now() + ${SOON} * 60000);
t.setUTCSeconds(0, 0);
pm.collectionVariables.set("soonStart", t.toISOString());`,
        expect: [422, "BOOKING_TOO_SOON"],
      },
      {
        name: `Reschedule to ${SOON} minutes from now`,
        op: ["PATCH", "/appointments/{appointment_id}/reschedule"],
        path: "/appointments/{{appointmentId}}/reschedule",
        body: { starts_at: "{{soonStart}}" },
        expect: [422, "BOOKING_TOO_SOON"],
      },
    ],
  },
  {
    name: "07 Reschedule and cancel",
    description:
      "Moves the booking to the second free slot (the same appointment id; repeating the move returns it unchanged), then cancels it. Cancelling twice is a 409, and the original Idempotency-Key cannot book again once its booking is cancelled.",
    requests: [
      {
        name: "Reschedule to the second slot",
        op: ["PATCH", "/appointments/{appointment_id}/reschedule"],
        path: "/appointments/{{appointmentId}}/reschedule",
        body: { starts_at: "{{slotStartNew}}" },
        expect: [200],
        tests: js`const a = pm.response.json();
pm.test("same appointment, new time", () => {
  pm.expect(a.id).to.eql(pm.collectionVariables.get("appointmentId"));
  pm.expect(new Date(a.starts_at).getTime()).to.eql(new Date(pm.collectionVariables.get("slotStartNew")).getTime());
  pm.expect(a.status).to.eql("booked");
});`,
      },
      {
        name: "Repeat the reschedule",
        op: ["PATCH", "/appointments/{appointment_id}/reschedule"],
        path: "/appointments/{{appointmentId}}/reschedule",
        body: { starts_at: "{{slotStartNew}}" },
        expect: [200],
        tests: js`pm.test("returns the appointment unchanged", () => {
  const a = pm.response.json();
  pm.expect(a.id).to.eql(pm.collectionVariables.get("appointmentId"));
  pm.expect(new Date(a.starts_at).getTime()).to.eql(new Date(pm.collectionVariables.get("slotStartNew")).getTime());
});`,
      },
      {
        name: "Cancel",
        op: ["PATCH", "/appointments/{appointment_id}/cancel"],
        path: "/appointments/{{appointmentId}}/cancel",
        body: { reason: "Reviewer run of the API collection" },
        expect: [200],
        tests: js`const a = pm.response.json();
pm.test("cancelled with the reason given", () => {
  pm.expect(a.status).to.eql("cancelled");
  pm.expect(a.cancellation_reason).to.eql("Reviewer run of the API collection");
  pm.expect(a.cancelled_at).to.be.a("string");
});`,
      },
      {
        name: "Cancel again",
        op: ["PATCH", "/appointments/{appointment_id}/cancel"],
        path: "/appointments/{{appointmentId}}/cancel",
        body: { reason: "Reviewer run of the API collection" },
        expect: [409, "APPOINTMENT_ALREADY_CANCELLED"],
      },
      {
        name: "Reuse the key after cancelling",
        op: ["POST", "/appointments"],
        headers: [["Idempotency-Key", "{{idempotencyKey}}"]],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{patientId}}", starts_at: "{{slotStart}}" },
        expect: [409, "IDEMPOTENCY_KEY_CONSUMED"],
      },
    ],
  },
  {
    name: `08 Change within ${LEAD} minutes`,
    description:
      `Cancelling or rescheduling a visit that starts in under ${LEAD} minutes is 409 CHANGE_TOO_LATE. The API never books a slot that close, so this needs an appointment made another way: \`make api-check\` writes one straight into the database of its own stack and passes its id as \`soonAppointmentId\`. To send these by hand, run \`KEEP_STACK=1 make api-check\` and paste the \`baseUrl\`, \`writeBaseUrl\` and \`soonAppointmentId\` it prints into the local environment. The seeded visit starts 5 to 35 minutes after the run, so use it straight away. Without it these requests are skipped.`,
    requests: [
      {
        name: `Cancel within ${LEAD} minutes`,
        op: ["PATCH", "/appointments/{appointment_id}/cancel"],
        path: "/appointments/{{soonAppointmentId}}/cancel",
        body: { reason: "Reviewer run of the API collection" },
        expect: [409, "CHANGE_TOO_LATE"],
      },
      {
        name: `Reschedule within ${LEAD} minutes`,
        op: ["PATCH", "/appointments/{appointment_id}/reschedule"],
        path: "/appointments/{{soonAppointmentId}}/reschedule",
        body: { starts_at: "{{slotStartNew}}" },
        expect: [409, "CHANGE_TOO_LATE"],
      },
    ],
  },
  {
    name: "09 Validation errors",
    description:
      "Requests the API refuses before touching anything. Each is a 422 (or a 404 for a resource that does not exist) in application/problem+json with a stable code; schema errors list the offending field in `errors[]`.",
    requests: [
      {
        name: "Doctor id is not a UUID",
        op: ["GET", "/doctors/{doctor_id}"],
        path: "/doctors/not-a-uuid",
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("path", "doctor_id"),
      },
      {
        name: "Doctor that does not exist",
        op: ["GET", "/doctors/{doctor_id}"],
        path: "/doctors/00000000-0000-4000-8000-000000000000",
        expect: [404, "DOCTOR_NOT_FOUND"],
      },
      {
        name: "Availability without a date",
        op: ["GET", "/doctors/{doctor_id}/availability"],
        path: "/doctors/{{doctorId}}/availability",
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("query", "date"),
      },
      {
        name: "Availability past the booking horizon",
        op: ["GET", "/doctors/{doctor_id}/availability"],
        path: "/doctors/{{doctorId}}/availability",
        query: [["date", "{{farDay}}"]],
        prerequest: js`pm.collectionVariables.set("farDay", new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10));`,
        expect: [422, "DATE_OUT_OF_RANGE"],
      },
      {
        name: "Appointment that does not exist",
        op: ["GET", "/appointments/{appointment_id}"],
        path: "/appointments/00000000-0000-4000-8000-000000000000",
        expect: [404, "APPOINTMENT_NOT_FOUND"],
      },
      {
        name: "Patient without a name",
        op: ["POST", "/patients"],
        body: {},
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("body", "full_name"),
      },
      {
        name: "Patient phone not in E.164",
        op: ["POST", "/patients"],
        body: { full_name: "Reviewer Phone", phone: "0712" },
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("body", "phone"),
      },
      {
        name: "Booking with no fields",
        op: ["POST", "/appointments"],
        body: {},
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("body", "starts_at"),
      },
      {
        name: "Idempotency-Key with a space",
        op: ["POST", "/appointments"],
        headers: [["Idempotency-Key", "has space"]],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{slotStartNew}}" },
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("header", "Idempotency-Key"),
      },
      {
        name: "Time without a UTC offset",
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{naiveStart}}" },
        prerequest: js`pm.collectionVariables.set("naiveStart", pm.collectionVariables.get("slotStartNew").slice(0, 19));`,
        expect: [422, "TIMEZONE_REQUIRED"],
      },
      {
        name: "Time in the past",
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{pastStart}}" },
        prerequest: js`const t = new Date(Date.now() - 86400000);
t.setUTCMinutes(0, 0, 0);
pm.collectionVariables.set("pastStart", t.toISOString());`,
        expect: [422, "SLOT_IN_PAST"],
      },
      {
        name: "Time off the 30-minute grid",
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{offGridStart}}" },
        prerequest: js`// Seven minutes after a free slot: inside working hours, off the grid.
pm.collectionVariables.set("offGridStart", new Date(new Date(pm.collectionVariables.get("slotStartNew")).getTime() + 7 * 60000).toISOString());`,
        expect: [422, "SLOT_MISALIGNED"],
      },
      {
        name: "Time outside working hours",
        op: ["POST", "/appointments"],
        body: { doctor_id: "{{doctorId}}", patient_id: "{{otherPatientId}}", starts_at: "{{nightStart}}" },
        prerequest: js`// 03:00 clinic time on the day the slots came from, with the offset the API used for them.
const start = pm.collectionVariables.get("slotStartNew");
pm.collectionVariables.set("nightStart", pm.collectionVariables.get("slotDay") + "T03:00:00" + start.slice(19));`,
        expect: [422, "OUTSIDE_WORKING_HOURS"],
      },
      {
        name: "Doctor that does not exist, on a booking",
        op: ["POST", "/appointments"],
        body: { doctor_id: "00000000-0000-4000-8000-000000000000", patient_id: "{{otherPatientId}}", starts_at: "{{slotStartNew}}" },
        expect: [422, "UNKNOWN_DOCTOR"],
      },
      {
        name: "Cancel reason too short",
        op: ["PATCH", "/appointments/{appointment_id}/cancel"],
        path: "/appointments/{{appointmentId}}/cancel",
        body: { reason: "x" },
        expect: [422, "VALIDATION_ERROR"],
        tests: fieldError("body", "reason"),
      },
    ],
  },
];

// ---- build -------------------------------------------------------------------------------

function buildRequest(r) {
  const [method, specPath] = r.op;
  const op = operation(method, specPath);
  const [status, code] = r.expect;
  const path = r.path ?? specPath;
  const query = r.query ?? [];
  const qs = query.length ? "?" + query.map(([k, v]) => `${k}=${v}`).join("&") : "";
  const headers = [...(r.body !== undefined ? [["Content-Type", "application/json"]] : []), ...(r.headers ?? [])];

  const test = code
    ? [expectProblem(status, code), schemaTest(responseSchema(op, status))]
    : [expectJson(status), schemaTest(responseSchema(op, status))];
  if (r.tests) test.push(r.tests);

  const event = [];
  // Reads go to baseUrl; anything else goes to writeBaseUrl, which production does not define.
  const host = method === "GET" ? "baseUrl" : "writeBaseUrl";
  const used = [...JSON.stringify([host, path, query, headers, r.body ?? null]).matchAll(/{{\s*([A-Za-z0-9_]+)\s*}}/g)].map((m) => m[1]);
  const pre = r.prerequest ?? "";
  // Variables the request's scripts read: the pre-request's inputs, and what its tests compare with.
  const reads = [...(pre + (r.tests ?? "")).matchAll(/collectionVariables\.get\("([A-Za-z0-9_]+)"\)/g)].map((m) => m[1]);
  const sets = [...pre.matchAll(/collectionVariables\.set\("([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const needs = [...new Set([...(host === "writeBaseUrl" ? [host] : []), ...used, ...reads])].filter((v) => v !== "baseUrl" && !sets.includes(v));
  event.push({ listen: "prerequest", script: { type: "text/javascript", exec: guard(needs, r.prerequest).split("\n") } });
  event.push({ listen: "test", script: { type: "text/javascript", exec: test.join("\n").split("\n") } });

  const contractText = [op.summary, op.description].filter(Boolean).join(". ");
  const request = {
    method,
    header: headers.map(([key, value]) => ({ key, value })),
    url: {
      raw: `{{${host}}}${path}${qs}`,
      host: [`{{${host}}}`],
      path: path.split("/").filter(Boolean),
      ...(query.length ? { query: query.map(([key, value]) => ({ key, value })) } : {}),
    },
    description: `\`${method} ${specPath}\` (${op.operationId}). Expects ${status}${code ? ` ${code}` : ""}.\n\nFrom the contract: ${contractText}`,
  };
  if (r.body !== undefined) request.body = JSON_BODY(r.body);
  return { name: r.name, event, request };
}

function build() {
  const used = new Set(FOLDERS.flatMap((f) => f.requests.map((r) => `${r.op[0]} ${r.op[1]}`)));
  const publicOps = Object.entries(SPEC.paths)
    .filter(([p]) => !p.startsWith("/internal/"))
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
  const uncovered = publicOps.filter((o) => !used.has(o) && !NOT_IN_JOURNEY[o]);
  if (uncovered.length) throw new Error(`public operations missing from the collection: ${uncovered.join(", ")}`);
  const stale = Object.keys(NOT_IN_JOURNEY).filter((o) => !publicOps.includes(o));
  if (stale.length) throw new Error(`NOT_IN_JOURNEY names operations the contract no longer has: ${stale.join(", ")}`);

  const left = Object.entries(NOT_IN_JOURNEY).map(([o, why]) => `- \`${o}\`: ${why}.`);
  const collection = {
    info: {
      name: `${SPEC.info.title} reviewer journey`,
      description: [
        `Built from contracts/openapi.json (API version ${SPEC.info.version}) by scripts/api_collection.mjs; edit that script, not this file.`,
        "",
        "Pick the `local` or `production` environment and run the folders in order. IDs and times flow from one request to the next through collection variables, and every time is computed from now, so the run never goes stale.",
        "",
        "Requests other than GET go to `writeBaseUrl`. The local environment sets it; the production environment does not, so those requests are skipped there, and a client that ignores the scripts has no host to send them to.",
        "",
        "Public operations not in the journey:",
        ...left,
      ].join("\n"),
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    variable: [
      "doctorId", "slotDay", "slotSearch", "slotMinutes", "slotStart", "slotStartNew", "patientId", "otherPatientId",
      "idempotencyKey", "appointmentId", "soonStart", "farDay", "naiveStart", "pastStart", "offGridStart", "nightStart",
    ].map((key) => ({ key, value: "" })),
    item: FOLDERS.map((f) => ({ name: f.name, description: f.description, item: f.requests.map(buildRequest) })),
  };

  const env = (name, baseUrl, writeBaseUrl) => ({
    name: `Clinic booking API, ${name}`,
    values: [
      { key: "baseUrl", value: baseUrl, type: "default", enabled: true },
      ...(writeBaseUrl ? [{ key: "writeBaseUrl", value: writeBaseUrl, type: "default", enabled: true }] : []),
      { key: "soonAppointmentId", value: "", type: "default", enabled: true },
    ],
    _postman_variable_scope: "environment",
  });

  return {
    "clinic-booking.postman_collection.json": collection,
    // The `make up` stack (compose publishes the API on API_HOST_PORT, 8080 by default).
    "local.postman_environment.json": env("local (docker compose)", "http://localhost:8080", "http://localhost:8080"),
    // The public path is the booking site's /api proxy: Cloud Run itself is IAM-only. No
    // writeBaseUrl on purpose: writes need it passed in (API_WRITES=1 make api-check-prod).
    "production.postman_environment.json": env("production (read-only)", "https://clinic.ericgitangu.com/api", null),
  };
}

const files = build();
const check = process.argv.includes("--check");
let drift = 0;
for (const [name, body] of Object.entries(files)) {
  const text = JSON.stringify(body, null, 2) + "\n";
  const target = join(OUT, name);
  if (check) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // a missing file is drift, reported below
    }
    if (current !== text) {
      process.stderr.write(`docs/api/${name} is out of date: run node scripts/api_collection.mjs\n`);
      drift += 1;
    }
  } else {
    writeFileSync(target, text);
    process.stdout.write(`wrote docs/api/${name}\n`);
  }
}
process.exit(drift ? 1 : 0);
