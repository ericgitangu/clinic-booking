// The dashboard's cached metrics against the real app, API and database.
//
// The trick that makes the cache visible: a booking made straight through the public API does not
// go through the admin app, so nothing expires the cached numbers. The real count moves, the
// dashboard does not, until something in the admin app expires the tag (a cancel, an access
// change, the refresh button) or sixty seconds pass. Each test checks the real count from the API
// before and after, so a stale number is a failure and not a guess.
import { lastDays } from "../src/lib/clinic-time";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { EMAIL, internal, OWNER } from "./support/stack";
import { expect, test } from "./support/fixtures";
import type { Page } from "@playwright/test";

interface Metrics {
  totals: { upcoming_active: number; cancelled: number };
}

const owner = { email: OWNER, role: "owner" };

async function truth(): Promise<Metrics["totals"]> {
  const week = lastDays(new Date(), 7);
  const res = await internal<Metrics>(
    "GET",
    `/internal/admin/metrics?from=${week.from}&to=${week.to}&bucket=day`,
    owner,
  );
  expect(res.status).toBe(200);
  return res.body.totals;
}

const upcoming = (page: Page) => page.getByTestId("kpi-upcoming-booked");

/** Presses Refresh and waits until the page shows the real count, so the next step starts fresh. */
async function refreshUntil(page: Page, expected: number) {
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(upcoming(page)).toHaveText(String(expected));
}

test("a booking the admin app did not see stays hidden until Refresh", async ({
  as,
}) => {
  const page = await as("owner");
  await page.goto("/dashboard?days=7");
  await refreshUntil(page, (await truth()).upcoming_active);
  const before = (await truth()).upcoming_active;

  await bookOneStraightThroughTheApi();
  expect((await truth()).upcoming_active).toBe(before + 1);

  // Cached: the real count moved, the page did not.
  await page.reload();
  await expect(upcoming(page)).toHaveText(String(before));

  await refreshUntil(page, before + 1);
  // And it stays right on the next load.
  await page.reload();
  await expect(upcoming(page)).toHaveText(String(before + 1));
});

test("an admin's cancel shows on the dashboard at once, with no refresh and no wait", async ({
  as,
}) => {
  // An appointment made for this test, so nothing the other specs use is touched.
  const id = await bookOneStraightThroughTheApi();
  const page = await as("admin");
  await page.goto("/dashboard?days=7");
  await refreshUntil(page, (await truth()).upcoming_active);
  const before = await truth();
  await expect(page.getByTestId("kpi-cancellations")).toHaveText(
    String(before.cancelled),
  );

  await page.goto(`/dashboard/appointments/${id}`);
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByLabel("Reason").fill("patient called to cancel");
  await dialog.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Appointment cancelled.")).toBeVisible();

  const after = await truth();
  expect(after.cancelled).toBe(before.cancelled + 1);
  expect(after.upcoming_active).toBe(before.upcoming_active - 1);
  await page.goto("/dashboard?days=7");
  await expect(page.getByTestId("kpi-cancellations")).toHaveText(
    String(after.cancelled),
  );
  await expect(upcoming(page)).toHaveText(String(after.upcoming_active));
});

test("an access change expires the cache too", async ({ as }) => {
  const page = await as("owner");
  await page.goto("/dashboard?days=7");
  await refreshUntil(page, (await truth()).upcoming_active);
  const before = (await truth()).upcoming_active;
  await bookOneStraightThroughTheApi();
  await page.reload();
  await expect(upcoming(page)).toHaveText(String(before));

  try {
    // Change a role through the Access page (the real server action), then look again.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/access");
    await page
      .getByRole("button", { name: `Change role of ${EMAIL.viewer}` })
      .click();
    await page.locator("#change-role").click();
    await page.getByRole("option", { name: /^Admin/ }).click();
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(page.getByText(`${EMAIL.viewer} is now admin.`)).toBeVisible();

    await page.goto("/dashboard?days=7");
    await expect(upcoming(page)).toHaveText(String(before + 1));
  } finally {
    // Whatever happened above, the viewer is a viewer again for every other spec and every rerun,
    // put back through the real API as the owner.
    const back = await internal(
      "PATCH",
      `/internal/admin/access/${encodeURIComponent(EMAIL.viewer)}`,
      owner,
      { role: "viewer" },
    );
    expect(back.status).toBe(200);
  }
});

test.describe("a cached value is never handed to someone who may not see it", () => {
  test.beforeEach(async ({ as }) => {
    // Make sure there is a warm entry for the default range before the outsider arrives.
    const page = await as("owner");
    await page.goto("/dashboard");
    await expect(upcoming(page)).toHaveText(/^\d+$/);
  });

  test("signed out goes to sign-in", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/$/);
    await expect(upcoming(page)).toHaveCount(0);
    await context.close();
  });

  test("signed in without a role is a 403 with no figures", async ({ as }) => {
    for (const who of ["stranger", "revoked"] as const) {
      const page = await as(who);
      const res = await page.goto("/dashboard");
      expect(res?.status()).toBe(403);
      await expect(upcoming(page)).toHaveCount(0);
      await page.context().clearCookies();
    }
  });
});
