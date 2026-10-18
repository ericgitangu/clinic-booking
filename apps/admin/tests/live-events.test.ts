import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS,
  addEvent,
  after,
  describe as sentence,
  parseLiveEvent,
  type LiveEvent,
} from "@/lib/live-events";

const DOCTOR = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const APPT = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

const viewer = (over: Record<string, unknown> = {}) => ({
  event_type: "booked",
  doctor_id: DOCTOR,
  local_date: "2026-10-21",
  from_local_date: null,
  from_starts_at: null,
  to_starts_at: "2026-10-21T06:30:00.000000Z",
  seq: "845.17",
  ...over,
});
const staff = (over: Record<string, unknown> = {}) =>
  viewer({
    appointment_id: APPT,
    patient_name: "Wanjiru Kamau",
    cancellation_reason: null,
    ...over,
  });

describe("parseLiveEvent", () => {
  it("reads the staff shape for owners and admins", () => {
    for (const role of ["owner", "admin"] as const) {
      const ev = parseLiveEvent(JSON.stringify(staff()), role);
      expect(ev).toMatchObject({
        seq: "845.17",
        kind: "booked",
        patientName: "Wanjiru Kamau",
        appointmentId: APPT,
      });
    }
  });

  it("reads the minimised shape for viewers, with no person in it", () => {
    const ev = parseLiveEvent(JSON.stringify(viewer()), "viewer");
    expect(ev).toMatchObject({
      kind: "booked",
      patientName: null,
      appointmentId: null,
    });
  });

  it("refuses a viewer's message that carries any personal field", () => {
    for (const k of ["patient_name", "appointment_id", "cancellation_reason"]) {
      expect(
        parseLiveEvent(JSON.stringify(viewer({ [k]: "x" })), "viewer"),
      ).toBeNull();
    }
    // the full staff message on a viewer's stream is refused whole, not trimmed
    expect(parseLiveEvent(JSON.stringify(staff()), "viewer")).toBeNull();
  });

  it("refuses a staff message missing its person fields, and anything that is not an event", () => {
    expect(parseLiveEvent(JSON.stringify(viewer()), "admin")).toBeNull();
    for (const bad of [
      "",
      "null",
      "[]",
      "{",
      '{"event_type":"deleted"}',
      JSON.stringify(staff({ seq: "01.2" })),
    ]) {
      expect(parseLiveEvent(bad, "owner")).toBeNull();
    }
  });
});

describe("ordering", () => {
  it("compares (txid, id) as 64-bit pairs, txid first", () => {
    expect(after("2.1", "1.99")).toBe(true);
    expect(after("1.2", "1.1")).toBe(true);
    expect(after("1.1", "1.1")).toBe(false);
    // beyond Number.MAX_SAFE_INTEGER
    expect(after("18446744073709551615.1", "18446744073709551614.9")).toBe(
      true,
    );
  });

  const ev = (seq: string): LiveEvent => ({
    seq,
    kind: "booked",
    doctorId: DOCTOR,
    localDate: "2026-10-21",
    fromLocalDate: null,
    fromStartsAt: null,
    toStartsAt: "2026-10-21T06:30:00.000000Z",
    appointmentId: null,
    patientName: null,
    cancellationReason: null,
  });

  it("keeps the newest first and drops a repeat", () => {
    let list: LiveEvent[] = [];
    for (const s of ["5.1", "5.3", "5.2", "5.3"]) list = addEvent(list, ev(s));
    expect(list.map((e) => e.seq)).toEqual(["5.3", "5.2", "5.1"]);
  });

  it("holds at most MAX_EVENTS", () => {
    let list: LiveEvent[] = [];
    for (let i = 1; i <= MAX_EVENTS + 10; i++)
      list = addEvent(list, ev(`7.${i}`));
    expect(list).toHaveLength(MAX_EVENTS);
    expect(list[0].seq).toBe(`7.${MAX_EVENTS + 10}`);
  });
});

describe("describe", () => {
  const booked = parseLiveEvent(JSON.stringify(staff()), "owner")!;
  it("names the patient and doctor for staff, and only the time for viewers", () => {
    expect(sentence(booked, "Dr. Achieng Otieno", "owner")).toBe(
      "New booking: Wanjiru Kamau, Wed 21 Oct 09:30 with Dr. Achieng Otieno",
    );
    const v = parseLiveEvent(JSON.stringify(viewer()), "viewer")!;
    const text = sentence(v, "Dr. Achieng Otieno", "viewer");
    expect(text).toBe("New booking: Wed 21 Oct 09:30 with Dr. Achieng Otieno");
    expect(text).not.toContain("Wanjiru");
  });

  it("says where a reschedule came from and why a cancellation happened (staff only)", () => {
    const re = parseLiveEvent(
      JSON.stringify(
        staff({
          event_type: "rescheduled",
          from_starts_at: "2026-10-20T06:00:00.000000Z",
          to_starts_at: "2026-10-21T06:30:00.000000Z",
        }),
      ),
      "admin",
    )!;
    expect(sentence(re, undefined, "admin")).toContain(
      "(was Tue 20 Oct 09:00)",
    );
    const cx = parseLiveEvent(
      JSON.stringify(
        staff({
          event_type: "cancelled",
          from_starts_at: "2026-10-21T06:30:00.000000Z",
          to_starts_at: null,
          cancellation_reason: "Family emergency",
        }),
      ),
      "owner",
    )!;
    expect(sentence(cx, undefined, "owner")).toContain(
      "Reason: Family emergency",
    );
  });
});
