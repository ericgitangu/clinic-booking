import { describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ role: "admin" as string | null }));
vi.mock("@/lib/session", () => ({
  authorise: async () =>
    read.role ? { role: read.role, sub: "s", email: "a@clinic.test" } : null,
  callerFor: () => ({}),
}));
vi.mock("@/lib/api", () => ({
  doctorNotice: async () => ({
    ok: true,
    data: {
      id: "n",
      status: "pending",
      reason: null,
      attempts: 0,
      sent_at: null,
      retryable: true,
    },
  }),
}));

import { GET } from "@/app/dashboard/read/doctor-notice/[id]/route";

const ID = "0f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8";
const call = (id = ID) =>
  GET(new Request("http://x/"), { params: Promise.resolve({ id }) });

describe("the doctor-notice read route", () => {
  it("passes the API's retryable on, with the rest of the state", async () => {
    read.role = "admin";
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      notice: {
        id: "n",
        status: "pending",
        reason: null,
        attempts: 0,
        sentAt: null,
        retryable: true,
      },
    });
  });

  it("tells a viewer nothing", async () => {
    read.role = null;
    expect((await call()).status).toBe(403);
  });

  it("refuses an id that is not a uuid", async () => {
    read.role = "admin";
    expect((await call("nope")).status).toBe(404);
  });
});
