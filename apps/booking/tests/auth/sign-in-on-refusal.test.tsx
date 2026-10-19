import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { needsSignIn } from "@/lib/auth-failure";

// When the API refuses the session (401) or the account (403), every page and action that talks to it
// for the signed-in person sends them to sign in again. A missing page (404) stays a missing page.
const refusal = (status: number) => ({
  ok: false as const,
  kind: "problem" as const,
  status,
  code: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN",
  detail: "refused",
});

const api = vi.hoisted(() => ({
  myAppointment: vi.fn(),
  myAppointments: vi.fn(),
  cancelMine: vi.fn(),
  getDoctor: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/session", () => ({
  getIdentity: async () => ({ sub: "s", email: "a@b.c", name: "Pat" }),
  callerFor: () => ({ sub: "s" }),
}));
vi.mock("@/components/account/sign-in-button", () => ({
  SignInButton: () => <button>Sign in with Google</button>,
}));
vi.mock("@/components/booking/appointment-actions", () => ({
  AppointmentActions: () => null,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/human-check", () => ({
  checkHuman: async () => ({ ok: true }),
}));
vi.mock("@/lib/email/acknowledge", () => ({ acknowledge: vi.fn() }));
vi.mock("@/lib/own", () => ({ ownBooked: async () => [] }));

const params = (id: string) => Promise.resolve({ id });
const ID = "11111111-1111-4111-8111-111111111111";

describe("needsSignIn", () => {
  it.each([
    [401, true],
    [403, false],
    [404, false],
    [409, false],
    [500, false],
    [503, false],
  ])("status %i is %s", (status, expected) => {
    expect(needsSignIn({ status })).toBe(expected);
  });
});

describe("pages", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      401,
      "appointment page",
      "@/app/appointments/[id]/page",
      "Sign in to see your appointment",
    ],
    [
      401,
      "reschedule page",
      "@/app/appointments/[id]/reschedule/page",
      "Sign in to reschedule",
    ],
    [
      401,
      "confirmation page",
      "@/app/book/confirmed/[id]/page",
      "Sign in to see your booking",
    ],
  ])("%i on the %s asks to sign in", async (status, _n, path, title) => {
    api.myAppointment.mockResolvedValue(refusal(status));
    const { default: Page } = await import(/* @vite-ignore */ path);
    const html = renderToStaticMarkup(
      await Page({ params: params(ID), searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain(title);
    expect(html).toContain("Sign in with Google");
  });

  it("401 on My appointments asks to sign in", async () => {
    api.myAppointments.mockResolvedValue(refusal(401));
    const { default: Page } = await import("@/app/appointments/(list)/page");
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Your session has ended");
  });

  it("404 on the appointment page is still not found", async () => {
    api.myAppointment.mockResolvedValue({
      ...refusal(404),
      code: "APPOINTMENT_NOT_FOUND",
    });
    const { default: Page } = await import("@/app/appointments/[id]/page");
    await expect(Page({ params: params(ID) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([401])(
    "cancel with a %i from the API says to sign in",
    async (status) => {
      api.cancelMine.mockResolvedValue(refusal(status));
      const { cancelAppointment } = await import("@/app/actions");
      const fd = new FormData();
      fd.set("appointment_id", ID);
      fd.set("reason", "Plans changed");
      const state = await cancelAppointment({ status: "idle" } as never, fd);
      expect(state).toMatchObject({
        status: "error",
        code: "UNAUTHENTICATED",
        message: "Sign in with Google to continue.",
      });
    },
  );
});

describe("403 is not a sign-in question", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["appointment page", "@/app/appointments/[id]/page"],
    ["reschedule page", "@/app/appointments/[id]/reschedule/page"],
    ["confirmation page", "@/app/book/confirmed/[id]/page"],
  ])(
    "the %s says there is no access, with a link back, and never 'sign in again'",
    async (_n, path) => {
      api.myAppointment.mockResolvedValue(refusal(403));
      const { default: Page } = await import(/* @vite-ignore */ path);
      const html = renderToStaticMarkup(
        await Page({ params: params(ID), searchParams: Promise.resolve({}) }),
      );
      expect(html).toContain("You don&#x27;t have access to this.");
      expect(html).toContain('href="/appointments"');
      expect(html).not.toMatch(/sign in again/i);
      expect(html).not.toContain("Sign in with Google");
    },
  );

  it("My appointments does the same", async () => {
    api.myAppointments.mockResolvedValue(refusal(403));
    const { default: Page } = await import("@/app/appointments/(list)/page");
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("You don&#x27;t have access to this.");
    expect(html).not.toMatch(/sign in again/i);
  });

  it("an action answers with the same words", async () => {
    api.cancelMine.mockResolvedValue(refusal(403));
    const { cancelAppointment } = await import("@/app/actions");
    const fd = new FormData();
    fd.set("appointment_id", ID);
    fd.set("reason", "Plans changed");
    const state = await cancelAppointment({ status: "idle" } as never, fd);
    expect(state).toMatchObject({
      status: "error",
      code: "FORBIDDEN",
      message: "You don't have access to this.",
    });
  });
});
