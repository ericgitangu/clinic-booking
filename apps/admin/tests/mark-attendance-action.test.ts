import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  notice: null as null | { id: string; status: string; reason: string | null },
  afterCalls: 0,
  sent: [] as string[],
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  updateTag: () => undefined,
}));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    h.afterCalls += 1;
    void fn();
  },
}));
vi.mock("@/lib/session", () => ({
  authorise: async () => ({ role: "admin", sub: "s", email: "a@clinic.test" }),
  callerFor: () => ({}),
  getStaff: async () => null,
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  markAttendance: async () => ({
    ok: true,
    status: 200,
    data: { doctor_notice: h.notice },
  }),
}));
vi.mock("@/emails/doctor-arrival", () => ({
  doctorPorts: () => ({}),
  sendDoctorArrival: async (input: { id: string }) =>
    void h.sent.push(input.id),
}));

import { markAttendance } from "@/lib/actions";

const ID = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

beforeEach(() => {
  h.afterCalls = 0;
  h.sent = [];
});

describe("markAttendance, the producer of the confirmation toast", () => {
  it("asks the toast to keep watching the email while it is pending, and schedules the send", async () => {
    h.notice = { id: "n1", status: "pending", reason: null };
    const res = await markAttendance(ID, "arrived", "at the desk");
    expect(res).toEqual({
      ok: true,
      message: "Marked arrived. Doctor email on its way.",
      watch: { appointmentId: ID },
    });
    expect(h.afterCalls).toBe(1);
    expect(h.sent).toEqual(["n1"]);
  });

  it.each([
    [
      { id: "n2", status: "skipped", reason: "no_email" },
      "Marked arrived. Email not sent (no doctor email).",
    ],
    [
      { id: "n3", status: "sent", reason: null },
      "Marked arrived. Doctor emailed.",
    ],
    [null, "Marked arrived."],
  ])(
    "has nothing to watch and sends nothing for %j",
    async (notice, message) => {
      h.notice = notice;
      const res = await markAttendance(ID, "arrived", "at the desk");
      expect(res).toEqual({ ok: true, message });
      expect(h.afterCalls).toBe(0);
    },
  );

  it("is a plain no-show confirmation with nothing to watch", async () => {
    h.notice = { id: "n4", status: "pending", reason: null };
    const res = await markAttendance(ID, "no_show", "left");
    expect(res).toEqual({ ok: true, message: "Marked no-show." });
  });
});
