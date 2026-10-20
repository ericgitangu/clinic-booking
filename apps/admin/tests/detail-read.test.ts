import { beforeEach, describe, expect, it, vi } from "vitest";

// The sheet's reads, with the API behind them replaced by promises the test settles by hand.
const gate = vi.hoisted(() => {
  const state = {
    audit: undefined as ((v: unknown) => void) | undefined,
    retryable: true,
    notice: undefined as ((v: unknown) => void) | undefined,
    started: [] as string[],
  };
  return state;
});

vi.mock("@/lib/api", () => ({
  auditList: () => {
    gate.started.push("audit");
    return new Promise((ok) => (gate.audit = ok));
  },
  doctorNotice: () => {
    gate.started.push("notice");
    return new Promise((ok) => (gate.notice = ok));
  },
}));
vi.mock("@/lib/session", () => ({
  authorise: async () => ({ role: "admin", sub: "s", email: "a@clinic.test" }),
  callerFor: () => ({}),
}));
vi.mock("@/lib/dashboard-data", () => ({
  loadLineage: async () => ({ found: true, events: [] }),
  loadAppointmentRow: async () => ({
    id: "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8",
    starts_at: "2026-10-27T07:00:00Z",
    ends_at: "2026-10-27T07:30:00Z",
    status: "booked",
    doctor_id: "d",
    doctor_name: "Dr. X",
    patient_name: "A B",
    view: "full",
    attendance: "arrived",
    staff_locked: false,
    cancellation_reason: null,
  }),
}));

import { loadDetail } from "@/lib/detail-read";

const ID = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";

beforeEach(() => {
  gate.started = [];
  gate.audit = gate.notice = undefined;
});

describe("loadDetail", () => {
  it.each([true, false])(
    "passes the API's retryable (%s) on to the sheet as it is",
    async (retryable) => {
      gate.retryable = retryable;
      const done = loadDetail(ID);
      await new Promise((r) => setTimeout(r, 20));
      gate.audit?.({ ok: true, data: { items: [] } });
      gate.notice?.({
        ok: true,
        data: {
          id: "n",
          status: "pending",
          reason: null,
          attempts: 1,
          sent_at: null,
          retryable,
        },
      });
      const res = await done;
      expect(res.ok && res.detail.doctorNotice?.retryable).toBe(retryable);
    },
  );

  it("starts the audit read and the doctor-notice read together, not one after the other", async () => {
    const done = loadDetail(ID);
    await new Promise((r) => setTimeout(r, 20));
    // Neither has answered, and both are already out.
    expect(gate.started.sort()).toEqual(["audit", "notice"]);
    gate.audit?.({ ok: true, data: { items: [] } });
    gate.notice?.({
      ok: true,
      data: {
        id: "n",
        status: "pending",
        reason: null,
        attempts: 1,
        sent_at: null,
        retryable: true,
      },
    });
    const res = await done;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // And the API's `retryable` reaches the sheet.
    expect(res.detail.doctorNotice).toEqual({
      id: "n",
      status: "pending",
      reason: null,
      attempts: 1,
      sentAt: null,
      retryable: true,
    });
  });
});
