// A small in-memory stand-in for the clinic API, used only by the end-to-end tests. It follows the
// same rules the real API enforces for the cases the tests cover (taken slot, past slot, one hour of
// notice, already cancelled, duplicate phone), so the booking screens can be driven through every
// error path without a database. The real API is exercised by backend tests and scripts/verify_claims.py.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.FAKE_API_PORT ?? 3199);
const CLINIC = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Idyllic Clinic",
  timezone: "Africa/Nairobi",
};
const DOCTORS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    full_name: "Dr Amani Otieno",
    specialty: "General practice",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    full_name: "Dr Wanjiru Kamau",
    specialty: "Paediatrics",
  },
].map((d) => ({
  ...d,
  clinic: CLINIC,
  working_hours: [0, 1, 2, 3, 4].map((weekday) => ({
    weekday,
    start_time: "09:00:00",
    end_time: "12:00:00",
  })),
}));

const patients = new Map();
const appointments = new Map();

const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });
const today = () => ymd.format(new Date());
const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000)
    .toISOString()
    .slice(0, 10);

function problem(res, status, code, detail) {
  // Every field the contract's Problem schema requires.
  res.writeHead(status, { "content-type": "application/problem+json" });
  res.end(
    JSON.stringify({
      type: `about:blank#${code}`,
      title: code,
      status,
      detail,
      instance: "/",
      code,
      request_id: randomUUID(),
    }),
  );
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return {};
  }
}

const slotsFor = (day) =>
  ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"].map((t) => {
    const start = new Date(`${day}T${t}:00+03:00`);
    return {
      starts_at: `${day}T${t}:00+03:00`,
      ends_at: new Date(start.getTime() + 30 * 60000)
        .toISOString()
        .replace(".000Z", "Z"),
      _t: start.getTime(),
    };
  });

const isTaken = (doctorId, ms, ignoreId) =>
  [...appointments.values()].some(
    (a) =>
      a.status === "booked" &&
      a.id !== ignoreId &&
      a.doctor_id === doctorId &&
      Date.parse(a.starts_at) === ms,
  );

// Returns a [status, code, detail] tuple when the time cannot be booked.
function checkTime(startsAt, doctorId, patientId, ignoreId) {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(startsAt))
    return [422, "TIMEZONE_REQUIRED", "starts_at needs an offset"];
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return [422, "VALIDATION_ERROR", "bad starts_at"];
  if (ms <= Date.now()) return [422, "SLOT_IN_PAST", "in the past"];
  if (ms < Date.now() + 60 * 60000)
    return [422, "BOOKING_TOO_SOON", "less than an hour ahead"];
  if (isTaken(doctorId, ms, ignoreId))
    return [409, "SLOT_TAKEN", "that slot is taken"];
  const clash = [...appointments.values()].some(
    (a) =>
      a.status === "booked" &&
      a.id !== ignoreId &&
      a.patient_id === patientId &&
      Date.parse(a.starts_at) === ms,
  );
  if (clash) return [409, "PATIENT_DOUBLE_BOOKED", "already booked then"];
  return null;
}

function view(a) {
  const d = DOCTORS.find((x) => x.id === a.doctor_id);
  return {
    ...a,
    doctor: { id: d.id, full_name: d.full_name, specialty: d.specialty },
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;
  try {
    if (m === "GET" && url.pathname === "/health")
      return json(res, 200, { status: "ok" });
    if (m === "GET" && url.pathname === "/doctors")
      return json(res, 200, { items: DOCTORS });
    if (m === "GET" && parts[0] === "doctors" && parts.length === 2) {
      const d = DOCTORS.find((x) => x.id === parts[1]);
      return d
        ? json(res, 200, d)
        : problem(res, 404, "DOCTOR_NOT_FOUND", "no such doctor");
    }
    if (m === "GET" && parts[0] === "doctors" && parts[2] === "availability") {
      const d = DOCTORS.find((x) => x.id === parts[1]);
      if (!d) return problem(res, 404, "DOCTOR_NOT_FOUND", "no such doctor");
      const day = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
        return problem(res, 422, "VALIDATION_ERROR", "bad date");
      if (day > addDays(today(), 90))
        return problem(res, 422, "DATE_OUT_OF_RANGE", "too far ahead");
      const free = slotsFor(day)
        .filter((s) => s._t >= Date.now() + 60 * 60000 && !isTaken(d.id, s._t))
        .map(({ starts_at, ends_at }) => ({ starts_at, ends_at }));
      return json(res, 200, {
        doctor_id: d.id,
        date: day,
        timezone: "Africa/Nairobi",
        slot_minutes: 30,
        slots: free,
      });
    }
    if (m === "POST" && url.pathname === "/patients") {
      const b = await readBody(req);
      if (typeof b.full_name !== "string" || b.full_name.length < 2)
        return problem(res, 422, "VALIDATION_ERROR", "full_name");
      if (b.phone && [...patients.values()].some((p) => p.phone === b.phone)) {
        return problem(
          res,
          409,
          "PATIENT_PHONE_EXISTS",
          "phone already registered",
        );
      }
      const p = {
        id: randomUUID(),
        full_name: b.full_name,
        phone: b.phone ?? null,
        email: b.email ?? null,
        created_at: new Date().toISOString(),
      };
      patients.set(p.id, p);
      return json(res, 201, p);
    }
    if (m === "POST" && url.pathname === "/appointments") {
      const b = await readBody(req);
      if (!DOCTORS.some((d) => d.id === b.doctor_id))
        return problem(res, 404, "DOCTOR_NOT_FOUND", "doctor");
      if (!patients.has(b.patient_id))
        return problem(res, 404, "PATIENT_NOT_FOUND", "patient");
      const bad = checkTime(
        String(b.starts_at ?? ""),
        b.doctor_id,
        b.patient_id,
      );
      if (bad) return problem(res, ...bad);
      const start = new Date(b.starts_at);
      const now = new Date().toISOString();
      const a = {
        id: randomUUID(),
        doctor_id: b.doctor_id,
        patient_id: b.patient_id,
        starts_at: b.starts_at,
        ends_at: new Date(start.getTime() + 30 * 60000).toISOString(),
        status: "booked",
        cancellation_reason: null,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      };
      appointments.set(a.id, a);
      return json(res, 201, a, { location: `/appointments/${a.id}` });
    }
    if (parts[0] === "appointments" && parts.length >= 2) {
      const a = appointments.get(parts[1]);
      if (!a)
        return problem(
          res,
          404,
          "APPOINTMENT_NOT_FOUND",
          "no such appointment",
        );
      if (m === "GET" && parts.length === 2) return json(res, 200, a);
      if (m === "PATCH" && parts[2] === "cancel") {
        const b = await readBody(req);
        if (a.status === "cancelled")
          return problem(
            res,
            409,
            "APPOINTMENT_ALREADY_CANCELLED",
            "already cancelled",
          );
        if (typeof b.reason !== "string" || b.reason.length < 3)
          return problem(res, 422, "VALIDATION_ERROR", "reason");
        Object.assign(a, {
          status: "cancelled",
          cancellation_reason: b.reason,
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return json(res, 200, a);
      }
      if (m === "PATCH" && parts[2] === "reschedule") {
        const b = await readBody(req);
        if (a.status === "cancelled")
          return problem(
            res,
            409,
            "APPOINTMENT_ALREADY_CANCELLED",
            "cancelled",
          );
        const bad = checkTime(
          String(b.starts_at ?? ""),
          a.doctor_id,
          a.patient_id,
          a.id,
        );
        if (bad) return problem(res, ...bad);
        Object.assign(a, {
          starts_at: b.starts_at,
          ends_at: new Date(Date.parse(b.starts_at) + 30 * 60000).toISOString(),
          updated_at: new Date().toISOString(),
        });
        return json(res, 200, a);
      }
    }
    if (m === "GET" && parts[0] === "patients" && parts[2] === "appointments") {
      const items = [...appointments.values()]
        .filter((a) => a.patient_id === parts[1])
        .sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at))
        .map(view);
      return json(res, 200, { items, next_cursor: null });
    }
    return problem(res, 404, "NOT_FOUND", "no such route");
  } catch (err) {
    return problem(res, 500, "INTERNAL_ERROR", String(err));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`fake api on ${PORT}`));
