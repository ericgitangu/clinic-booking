import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AppointmentActions } from "@/components/booking/appointment-actions";
import { STAFF_LOCK_TITLE } from "@/lib/staff-lock";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/app/actions", () => ({ cancelAppointment: async () => ({}) }));
vi.mock("@/components/booking/use-recaptcha", () => ({
  useRecaptcha: () => async () => "",
}));

const DAYS = 3 * 24 * 60 * 60_000;
const render = (staffLocked?: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AppointmentActions
        id="bc9111b0-0000-4000-8000-000000000000"
        when="Tue 20 Oct 13:30"
        startsAt={new Date(Date.now() + DAYS).toISOString()}
        serverNow={new Date().toISOString()}
        staffLocked={staffLocked}
      />
    </QueryClientProvider>,
  );

describe("a visit the clinic locked", () => {
  it("says so and offers no way to change it", () => {
    const html = render(true);
    expect(html).toContain(STAFF_LOCK_TITLE);
    expect(html).not.toContain("Reschedule");
    expect(html).not.toContain("Cancel");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("/reschedule");
  });

  it("still offers both changes on a visit that is not locked", () => {
    for (const flag of [false, undefined]) {
      const html = render(flag);
      expect(html).not.toContain(STAFF_LOCK_TITLE);
      expect(html).toContain("Reschedule");
      expect(html).toContain("Cancel");
    }
  });
});
