import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions are driven for real; only the edges are replaced: the session, the API reads
// and writes, the cache calls and after(), which here runs its callback so the send is observable.
const sent = vi.hoisted(() => ({
  patient: [] as unknown[][],
  invite: [] as unknown[][],
}));
const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => void fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/session", () => ({
  authorise: vi.fn(async () => ({
    sub: "s",
    email: "admin@clinic.test",
    role: "admin",
  })),
  callerFor: (_w: unknown, role: string) => ({ sub: "s", role }),
  getStaff: vi.fn(),
}));
vi.mock("@/lib/staff-mail", () => ({
  noticeToPatient: vi.fn(async (...a: unknown[]) => void sent.patient.push(a)),
  noticeOfInvite: vi.fn(async (...a: unknown[]) => void sent.invite.push(a)),
}));
const change = { audit_id: "a1", patient_name: "Pat", id: "x" };
vi.mock("@/lib/api", () => ({
  cancelForPatient: vi.fn(async () => ok(change)),
  rescheduleForPatient: vi.fn(async () => ok(change)),
  staffBook: vi.fn(async () => ok(change)),
  vetoAppointment: vi.fn(async () => ok(change)),
  inviteCreate: vi.fn(async () => ok({ email: "n@x.com", token: "tok" })),
  markAttendance: vi.fn(async () => ok({})),
  unlockAppointment: vi.fn(async () => ok({})),
}));

import {
  bookOnBehalf,
  cancelAppointment,
  createInvite,
  markAttendance,
  rescheduleAppointment,
  unlockAppointment,
  vetoAppointment,
} from "@/lib/actions";

beforeEach(() => {
  sent.patient.length = 0;
  sent.invite.length = 0;
});

describe("which staff actions email the patient", () => {
  it("cancel, move, book and veto each send once, with the reason given", async () => {
    await cancelAppointment("id", "clinic closed");
    await rescheduleAppointment("id", "2026-11-02T07:00:00Z", "doctor away");
    await bookOnBehalf({
      doctorId: "d",
      startsAt: "2026-11-02T07:00:00Z",
      reason: "called in",
      fullName: "Pat Test",
      phone: "",
      email: "",
    });
    await vetoAppointment("id", "keep the time");
    expect(sent.patient.map((a) => [a[0], a[3]])).toEqual([
      ["cancelled", "clinic closed"],
      ["rescheduled", "doctor away"],
      ["booked", "called in"],
      ["vetoed", "keep the time"],
    ]);
  });

  it("an invitation sends its email; marking attendance and unlocking send none", async () => {
    await createInvite("n@x.com", "viewer");
    expect(sent.invite).toHaveLength(1);
    await markAttendance("id", "arrived", "at the desk");
    await unlockAppointment("id", "all clear");
    expect(sent.patient).toHaveLength(0);
  });

  it("a refused write sends nothing", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.cancelForPatient).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "X",
    } as never);
    const r = await cancelAppointment("id", "reason here");
    expect(r.ok).toBe(false);
    expect(sent.patient).toHaveLength(0);
  });
});
