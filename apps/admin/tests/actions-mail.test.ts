import { beforeEach, describe, expect, it, vi } from "vitest";

// The server actions are driven for real; only the edges are replaced: the session, the API reads
// and writes, the cache calls and after(), which here runs its callback so the send is observable.
const sent = vi.hoisted(() => ({
  patient: [] as unknown[][],
  invite: [] as unknown[][],
  pass: [] as unknown[][],
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
  ownerEmails: () => new Set(["owner@clinic.test"]),
}));
vi.mock("@/lib/staff-mail", () => ({
  noticeToPatient: vi.fn(async (...a: unknown[]) => void sent.patient.push(a)),
  noticeOfInvite: vi.fn(async (...a: unknown[]) => void sent.invite.push(a)),
  noticeOfPassAccepted: vi.fn(
    async (...a: unknown[]) => void sent.pass.push(a),
  ),
}));
const change = { audit_id: "a1", patient_name: "Pat", id: "x" };
vi.mock("@/lib/api", () => ({
  cancelForPatient: vi.fn(async () => ok(change)),
  rescheduleForPatient: vi.fn(async () => ok(change)),
  staffBook: vi.fn(async () => ok(change)),
  vetoAppointment: vi.fn(async () => ok(change)),
  inviteCreate: vi.fn(async () => ok({ email: "n@x.com", token: "tok" })),
  passCreate: vi.fn(async () => ok({ token: "fake-pass" })),
  passAccept: vi.fn(async () =>
    ok({
      pass_id: "p1",
      email: "r@x.com",
      role: "admin",
      use: 1,
      of: 5,
      joined: true,
    }),
  ),
  markAttendance: vi.fn(async () => ok({})),
  unlockAppointment: vi.fn(async () => ok({})),
}));

import {
  acceptPass,
  bookOnBehalf,
  cancelAppointment,
  createInvite,
  createPass,
  markAttendance,
  rescheduleAppointment,
  unlockAppointment,
  vetoAppointment,
} from "@/lib/actions";

beforeEach(() => {
  sent.patient.length = 0;
  sent.invite.length = 0;
  sent.pass.length = 0;
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

describe("the owner's email when someone joins with a pass", () => {
  it("a new joiner emails the owner once, with the seat they took", async () => {
    const session = await import("@/lib/session");
    vi.mocked(session.getStaff).mockResolvedValueOnce({
      sub: "g1",
      email: "r@x.com",
      name: "R",
      image: null,
      role: null,
    });
    const r = await acceptPass("a-valid-looking-token");
    expect(r).toEqual({ ok: true, message: "You now have access as admin." });
    expect(sent.pass).toHaveLength(1);
    expect(sent.pass[0]![1]).toMatchObject({ pass_id: "p1", use: 1, of: 5 });
    expect([...(sent.pass[0]![2] as Set<string>)]).toEqual([
      "owner@clinic.test",
    ]);
  });

  it("someone who already had access takes no seat and sends nothing", async () => {
    const session = await import("@/lib/session");
    const api = await import("@/lib/api");
    vi.mocked(session.getStaff).mockResolvedValueOnce({
      sub: "g1",
      email: "r@x.com",
      name: "R",
      image: null,
      role: "admin",
    });
    vi.mocked(api.passAccept).mockResolvedValueOnce(
      ok({
        pass_id: "p1",
        email: "r@x.com",
        role: "admin",
        use: 1,
        of: 5,
        joined: false,
      }) as never,
    );
    const r = await acceptPass("a-valid-looking-token");
    expect(r).toEqual({
      ok: true,
      message: "You already have access as admin.",
    });
    expect(sent.pass).toHaveLength(0);
  });

  it("a refused pass is one plain message and sends nothing", async () => {
    const session = await import("@/lib/session");
    const api = await import("@/lib/api");
    vi.mocked(session.getStaff).mockResolvedValueOnce({
      sub: "g1",
      email: "r@x.com",
      name: "R",
      image: null,
      role: null,
    });
    vi.mocked(api.passAccept).mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: "PASS_INVALID",
    } as never);
    expect(await acceptPass("a-valid-looking-token")).toEqual({
      ok: false,
      message:
        "That reviewer pass is not valid. Ask the person who sent it for a new one.",
    });
    expect(sent.pass).toHaveLength(0);
  });
});

describe("making a pass", () => {
  it("is the owner's alone: an admin is refused before the API is asked", async () => {
    const api = await import("@/lib/api");
    vi.mocked(api.passCreate).mockClear();
    expect(await createPass("admin", 5, 14)).toEqual({
      ok: false,
      message: "Your account is not allowed to do this.",
    });
    expect(api.passCreate).not.toHaveBeenCalled();
  });

  it("an owner gets the link, with the token in the path", async () => {
    const session = await import("@/lib/session");
    vi.mocked(session.authorise).mockResolvedValueOnce({
      sub: "o",
      email: "owner@clinic.test",
      name: "O",
      image: null,
      role: "owner",
    });
    const r = await createPass("admin", 5, 14);
    expect(r.ok && r.link).toMatch(/\/pass\/fake-pass$/);
  });

  it.each([
    ["admin", 0, 14],
    ["admin", 11, 14],
    ["admin", 5, 0],
    ["admin", 5, 31],
    ["admin", 2.5, 14],
    ["owner", 5, 14],
  ])("%s, %s people, %s days is refused before the API", async (role, n, d) => {
    const session = await import("@/lib/session");
    const api = await import("@/lib/api");
    vi.mocked(api.passCreate).mockClear();
    vi.mocked(session.authorise).mockResolvedValueOnce({
      sub: "o",
      email: "owner@clinic.test",
      name: "O",
      image: null,
      role: "owner",
    });
    expect((await createPass(role, n, d)).ok).toBe(false);
    expect(api.passCreate).not.toHaveBeenCalled();
  });
});
