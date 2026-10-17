import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstDoctor, hhmm, patientOf, pick } from "./api";

// Each scenario takes its own day from pick(n), so scenarios can run in parallel. Run against the
// real API and database (docker compose), see playwright.config.ts.

// Next adds its own role=alert route announcer; ours are the ones inside the page.
const alertOf = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');
const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;
// A phone number no earlier run has used, in the format the API requires.
const phone = () =>
  `+2547${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, "0")}`;

async function bookThroughForm(
  page: Page,
  doctorId: string,
  startsAt: string,
  name = "Test Patient",
) {
  await page.goto(details(doctorId, startsAt));
  await page.getByLabel("Full name").fill(name);
  await page.getByRole("button", { name: "Confirm booking" }).click();
}

async function bookAndWait(
  page: Page,
  doctorId: string,
  startsAt: string,
  name?: string,
) {
  await bookThroughForm(page, doctorId, startsAt, name);
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test("books a visit from the doctor list to the confirmation", async ({
  page,
}) => {
  const { doctorId, day, slots } = await pick(0);
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { level: 1, name: "Book a visit" }),
  ).toBeVisible();
  await page.locator(`a[href="/book/${doctorId}"]`).click();
  await page.goto(`/book/${doctorId}?date=${day}`);
  await page.getByText(hhmm(slots[0]), { exact: true }).click();
  await page.getByRole("link", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/details\?starts_at=/);
  await page.getByLabel("Full name").fill("Amina Wanjiku");
  await page.getByLabel("Phone (optional)").fill(phone());
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await expect(page.getByText(hhmm(slots[0])).first()).toBeVisible();
  await page.getByRole("link", { name: "My appointments" }).first().click();
  await expect(page.getByText("Booked as Amina Wanjiku.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("the continue button stays disabled until a time is picked", async ({
  page,
}) => {
  const { doctorId, day, slots } = await pick(1);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByText(hhmm(slots[1]), { exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue" })).toBeVisible();
});

test("a double booking says the time was just taken and offers the next free times", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(2);
  const target = slots[0];
  const a = await newPage(browser);
  const b = await newPage(browser);
  // Both people open the same slot; the first one books it.
  await b.page.goto(details(doctorId, target));
  await bookAndWait(a.page, doctorId, target, "First Patient");

  await b.page.getByLabel("Full name").fill("Second Patient");
  await b.page.getByRole("button", { name: "Confirm booking" }).click();
  const alert = alertOf(b.page);
  await expect(alert).toContainText("That time was just taken.");
  await expect(alert).toContainText("Here are the next free times");
  // A suggested time leads straight to a details page for that time, and it books.
  const suggestion = alert.getByRole("link").first();
  const suggestedHref = await suggestion.getAttribute("href");
  await suggestion.click();
  // The page is already on a details URL (for the taken time), so wait for the suggested one,
  // otherwise the next click can land on the old page.
  await expect(b.page).toHaveURL(
    (u) => u.pathname + u.search === suggestedHref,
  );
  await b.page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    b.page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await a.ctx.close();
  await b.ctx.close();
});

test("cancelling asks for a reason and moves the appointment out of Upcoming", async ({
  page,
}) => {
  const { doctorId, slots } = await pick(3);
  await bookAndWait(page, doctorId, slots[0]);
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();
});

test("cancelling the same appointment twice reports that it is already cancelled", async ({
  page,
  context,
}) => {
  const { doctorId, slots } = await pick(4);
  await bookAndWait(page, doctorId, slots[0]);
  await page.goto("/appointments");
  const stale = await context.newPage();
  await stale.goto("/appointments");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("First time");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();

  // The second tab still shows the appointment as upcoming.
  await stale.getByRole("button", { name: "Cancel" }).click();
  await stale.getByLabel("Why are you cancelling?").fill("Second time");
  await stale.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(
    stale.getByText("This appointment is already cancelled.").first(),
  ).toBeVisible();
});

test("rescheduling moves the appointment to the new time", async ({ page }) => {
  const { doctorId, slots } = await pick(5);
  await bookAndWait(page, doctorId, slots[0]);
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await page.getByText(hhmm(slots[2]), { exact: true }).click();
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(page).toHaveURL(/\/appointments\?rescheduled=1/);
  await expect(page.getByText(hhmm(slots[2])).first()).toBeVisible();
});

test("a time that has already passed is refused with a plain message", async ({
  page,
}) => {
  const doctorId = await firstDoctor();
  await bookThroughForm(
    page,
    doctorId,
    new Date(Date.now() - 86_400_000).toISOString(),
  );
  await expect(alertOf(page)).toContainText("That time has already passed.");
});

test("a time less than an hour away is refused with a plain message", async ({
  page,
}) => {
  const doctorId = await firstDoctor();
  await bookThroughForm(
    page,
    doctorId,
    new Date(Date.now() + 30 * 60_000).toISOString(),
  );
  await expect(alertOf(page)).toContainText("at least an hour");
});

test("an invalid phone number is explained next to the field", async ({
  page,
}) => {
  const { doctorId, slots } = await pick(6);
  await page.goto(details(doctorId, slots[0]));
  await page.getByLabel("Full name").fill("Test Patient");
  await page.getByLabel("Phone (optional)").fill("0712345678");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("Use international format")).toBeVisible();
});

test("a booking is private to the browser that made it", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(7);
  const owner = await newPage(browser);
  await bookAndWait(owner.page, doctorId, slots[0], "Owner Patient");
  const appointmentId = owner.page.url().split("/").pop()!;

  // A browser with no cookie cannot open the confirmation.
  const stranger = await newPage(browser);
  const noCookie = await stranger.page.goto(`/book/confirmed/${appointmentId}`);
  expect(noCookie?.status()).toBe(404);

  // Neither can one holding a cookie that names the owner but was not signed by the server.
  const patientId = await patientOf(appointmentId);
  const forged = Buffer.from(
    JSON.stringify({ id: patientId, name: "Owner Patient" }),
  ).toString("base64url");
  await stranger.ctx.addCookies([
    {
      name: "clinic_patient",
      value: `${forged}.${"A".repeat(43)}`,
      url: "http://localhost:3100",
    },
  ]);
  const withForgery = await stranger.page.goto(
    `/book/confirmed/${appointmentId}`,
  );
  expect(withForgery?.status()).toBe(404);
  await stranger.page.goto("/appointments");
  await expect(
    stranger.page.getByText("You have not booked from this browser yet."),
  ).toBeVisible();
  await stranger.page.goto(`/appointments/${appointmentId}/reschedule`);
  await expect(
    stranger.page.getByRole("heading", { name: "Reschedule" }),
  ).toBeHidden();

  // The owner still can.
  const own = await owner.page.goto(`/book/confirmed/${appointmentId}`);
  expect(own?.status()).toBe(200);
  await owner.ctx.close();
  await stranger.ctx.close();
});

test("the booking screens never scroll sideways on a 360px phone", async ({
  page,
}) => {
  const { doctorId, day, slots } = await pick(8);
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    "/book",
    `/book/${doctorId}?date=${day}`,
    details(doctorId, slots[0]),
    "/appointments",
  ]) {
    await page.goto(path);
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(inner);
  }
});
