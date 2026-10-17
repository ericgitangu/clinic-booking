// The dashboard against the real API and database. Expected numbers are read from the real API
// with a real signed assertion and compared with what the page shows; histories are the ones the
// seeding really produced by booking, rescheduling and cancelling.
import { addDays, lastDays, localDate } from "../src/lib/clinic-time";
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { expect, seeded, test } from "./support/fixtures";

interface Metrics {
  totals: { upcoming_active: number; cancelled: number };
  per_doctor: { name: string }[];
}
interface Lineage {
  events: { event_type: string }[];
}

const owner = { email: OWNER, role: "owner" };

test.describe("owner dashboard", () => {
  test("shows the numbers the API reports", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=7");
    const week = lastDays(new Date(), 7);
    const m = await internal<Metrics>(
      "GET",
      `/internal/admin/metrics?from=${week.from}&to=${week.to}&bucket=day`,
      owner,
    );
    expect(m.status).toBe(200);

    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("staff-role")).toHaveText("Owner");
    await expect(page.getByTestId("kpi-upcoming-booked")).toHaveText(
      String(m.body.totals.upcoming_active),
    );
    await expect(page.getByTestId("kpi-cancellations")).toHaveText(
      String(m.body.totals.cancelled),
    );
    await expect(page.getByTestId("kpi-utilisation")).toHaveText(
      /^(\d+%|None)$/,
    );
    // The seeding booked at least ten and cancelled one, so these are not zeros.
    expect(m.body.totals.upcoming_active).toBeGreaterThanOrEqual(10);
    expect(m.body.totals.cancelled).toBeGreaterThanOrEqual(1);
    for (const d of m.body.per_doctor) {
      await expect(page.getByText(d.name).first()).toBeVisible();
    }
    await expect(
      page.getByRole("img", { name: /Line chart of bookings/ }),
    ).toBeVisible();
  });

  test("today's count matches the API", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const today = localDate(new Date());
    const list = await internal<{
      items: unknown[];
      next_cursor: string | null;
    }>(
      "GET",
      `/internal/admin/appointments?status=booked&from=${today}&to=${addDays(today, 1)}&limit=100`,
      owner,
    );
    const expected = `${list.body.items.length}${list.body.next_cursor ? "+" : ""}`;
    await expect(page.getByTestId("kpi-today")).toHaveText(expected);
  });

  test("the range tabs change the range in the address", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    await page
      .getByRole("navigation", { name: "Range" })
      .getByRole("link", { name: "30 days" })
      .click();
    await expect(page).toHaveURL(/days=30/);
    await expect(
      page.getByRole("link", { name: "30 days", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("the status filter narrows the list to cancelled appointments", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await page.getByRole("combobox", { name: "Show" }).click();
    await page.getByRole("option", { name: "Cancelled" }).click();
    await expect(page).toHaveURL(/status=cancelled/);
    const rows = page.getByTestId("appointments-table").getByRole("row");
    await expect(rows.nth(1)).toContainText("Cancelled");
    for (const text of await page
      .getByTestId("appointments-table")
      .locator("tbody tr")
      .allInnerTexts()) {
      expect(text).toContain("Cancelled");
    }
  });
});

test.describe("an appointment's history", () => {
  test("a rescheduled appointment reads booked, then rescheduled", async ({
    as,
  }) => {
    const id = seeded().rescheduled;
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    const api = await internal<Lineage>(
      "GET",
      `/internal/admin/appointments/${id}/lineage`,
      owner,
    );
    expect(api.body.events.map((e) => e.event_type)).toEqual([
      "booked",
      "rescheduled",
    ]);
    const steps = page.getByTestId("lineage").locator("> li");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText("Booked");
    await expect(steps.nth(1)).toContainText("Rescheduled");
  });

  test("a cancelled appointment reads booked, then cancelled, with its reason", async ({
    as,
  }) => {
    const id = seeded().cancelled;
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    const steps = page.getByTestId("lineage").locator("> li");
    await expect(steps.nth(0)).toContainText("Booked");
    await expect(steps.nth(1)).toContainText("Cancelled");
    await expect(
      page.getByText("Reason: patient called to cancel"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
  });

  test("an unknown appointment is a 404", async ({ as }) => {
    const page = await as("viewer");
    const res = await page.goto(
      "/dashboard/appointments/00000000-0000-4000-8000-0000000000ff",
    );
    expect(res?.status()).toBe(404);
  });
});

test.describe("acting for a patient", () => {
  test("a viewer sees the history but no actions", async ({ as }) => {
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${seeded().free[0]}`);
    await expect(page.getByTestId("lineage-booked")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reschedule" })).toHaveCount(
      0,
    );
  });

  test("an admin cancels an appointment and the history records it", async ({
    as,
  }) => {
    const id = seeded().free[1];
    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await page.getByRole("button", { name: "Cancel appointment" }).click();
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Cancel appointment" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason").fill("patient called to cancel");
    await confirm.click();
    await expect(page.getByText("Appointment cancelled.")).toBeVisible();
    await expect(page.getByTestId("lineage-cancelled")).toBeVisible();

    const real = await publicApi<{
      status: string;
      cancellation_reason: string;
    }>("GET", `/appointments/${id}`);
    expect(real.body.status).toBe("cancelled");
    expect(real.body.cancellation_reason).toContain("patient called to cancel");
    // And once cancelled the actions are gone.
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
  });

  test("an admin moves an appointment to a free time", async ({ as }) => {
    const id = seeded().free[2];
    const before = await publicApi<{ starts_at: string; doctor_id: string }>(
      "GET",
      `/appointments/${id}`,
    );
    // A day with free times: the day after the appointment's own.
    let date = addDays(before.body.starts_at.slice(0, 10), 1);
    let freeTimes = 0;
    for (let i = 0; i < 10 && freeTimes === 0; i++) {
      const avail = await publicApi<{ slots: unknown[] }>(
        "GET",
        `/doctors/${before.body.doctor_id}/availability?date=${date}`,
      );
      freeTimes = avail.body.slots.length;
      if (freeTimes === 0) date = addDays(date, 1);
    }
    expect(freeTimes).toBeGreaterThan(0);

    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await page.getByRole("button", { name: "Reschedule" }).click();
    await page.getByLabel("Day").fill(date);
    await page.locator("#move-slot").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Move appointment" }).click();
    await expect(page.getByText("Appointment rescheduled.")).toBeVisible();

    const after = await publicApi<{ starts_at: string }>(
      "GET",
      `/appointments/${id}`,
    );
    expect(after.body.starts_at).not.toBe(before.body.starts_at);
    expect(after.body.starts_at.slice(0, 10)).toBe(date);
    const lineage = await internal<Lineage>(
      "GET",
      `/internal/admin/appointments/${id}/lineage`,
      owner,
    );
    expect(lineage.body.events.map((e) => e.event_type)).toEqual([
      "booked",
      "rescheduled",
    ]);
  });
});

test.describe("layout", () => {
  test.describe("on a phone", () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test("appointments are cards, not a table, and nothing scrolls sideways", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/dashboard");
      await expect(page.getByTestId("appointments-cards")).toBeVisible();
      await expect(page.getByTestId("appointments-table")).toBeHidden();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("access entries are cards with finger-sized buttons", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/access");
      await expect(page.getByTestId("access-cards")).toBeVisible();
      await expect(page.getByTestId("access-table")).toBeHidden();
      const box = await page
        .getByTestId("access-cards")
        .getByRole("button", { name: `Change role of ${EMAIL.admin}` })
        .boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  });

  test.describe("on a desktop", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("appointments are a table that pages to older ones and back", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/dashboard");
      await expect(page.getByTestId("appointments-table")).toBeVisible();
      await expect(page.getByTestId("appointments-cards")).toBeHidden();
      await page.getByRole("link", { name: "Older appointments" }).click();
      await expect(page).toHaveURL(/cursor=/);
      await expect(page.getByTestId("appointments-table")).toBeVisible();
      await page.getByRole("link", { name: "Back to latest" }).click();
      await expect(page).not.toHaveURL(/cursor=/);
    });
  });
});
