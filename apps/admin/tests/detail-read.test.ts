import { beforeEach, describe, expect, it, vi } from "vitest";

// The sheet's reads, with the API behind them replaced by promises the test settles by hand.
const gate = vi.hoisted(() => {
  type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
  const deferred = (): Deferred => {
    let resolve: (v: unknown) => void = () => undefined;
    const promise = new Promise((ok) => (resolve = ok));
    return { promise, resolve };
  };
  const state = {
    audit: deferred(),
    notice: deferred(),
    started: [] as string[],
    // Resolves when both reads have been asked for, whatever the timing.
    bothStarted: deferred(),
    reset() {
      state.audit = deferred();
      state.notice = deferred();
      state.bothStarted = deferred();
      state.started = [];
    },
    started_(name: string) {
      state.started.push(name);
      if (state.started.length === 2) state.bothStarted.resolve(true);
    },
  };
  return state;
});

vi.mock("@/lib/api", () => ({
  auditList: () => {
    gate.started_("audit");
    return gate.audit.promise;
  },
  doctorNotice: () => {
    gate.started_("notice");
    return gate.notice.promise;
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

beforeEach(() => gate.reset());

const notice = (retryable: boolean) => ({
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

describe("loadDetail", () => {
  it.each([true, false])(
    "passes the API's retryable (%s) on to the sheet as it is",
    async (retryable) => {
      const done = loadDetail(ID);
      await gate.bothStarted.promise;
      gate.audit.resolve({ ok: true, data: { items: [] } });
      gate.notice.resolve(notice(retryable));
      const res = await done;
      expect(res.ok && res.detail.doctorNotice?.retryable).toBe(retryable);
    },
  );

  it("starts the audit read and the doctor-notice read together, not one after the other", async () => {
    const done = loadDetail(ID);
    // Neither read has answered, and both are already out: with one after the other, the second
    // would never start while the first is waiting, and this would not resolve.
    await gate.bothStarted.promise;
    expect([...gate.started].sort()).toEqual(["audit", "notice"]);
    gate.audit.resolve({ ok: true, data: { items: [] } });
    gate.notice.resolve(notice(true));
    const res = await done;
    expect(res.ok && res.detail.doctorNotice).toEqual({
      id: "n",
      status: "pending",
      reason: null,
      attempts: 1,
      sentAt: null,
      retryable: true,
    });
  });
});
