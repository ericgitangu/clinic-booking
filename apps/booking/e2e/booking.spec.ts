import { expect, test, type Browser, type Page } from "@playwright/test";

// These run against e2e/fake-api.mjs, which enforces the same booking rules as the real API for
// the cases below. Each test books on its own day so tests can run in parallel.
// Next adds its own role=alert route announcer; ours are the ones inside the page.
const alertOf = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');
const DOCTOR = "11111111-1111-4111-8111-111111111111";
const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" });
const dayAhead = (n: number) =>
  new Date(Date.parse(`${ymd.format(new Date())}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
const slot = (day: string, hhmm: string) => `${day}T${hhmm}:00+03:00`;
const details = (startsAt: string) =>
  `/book/${DOCTOR}/details?starts_at=${encodeURIComponent(startsAt)}`;

async function bookThroughForm(
  page: Page,
  startsAt: string,
  name = "Test Patient",
) {
  await page.goto(details(startsAt));
  await page.getByLabel("Full name").fill(name);
  await page.getByRole("button", { name: "Confirm booking" }).click();
}

test("books a visit from the doctor list to the confirmation", async ({
  page,
}) => {
  const day = dayAhead(3);
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { level: 1, name: "Book a visit" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "See free times" }).first().click();
  await page.goto(`/book/${DOCTOR}?date=${day}`);
  await page.getByText("09:00", { exact: true }).click();
  await page.getByRole("link", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/details\?starts_at=/);
  await page.getByLabel("Full name").fill("Amina Wanjiku");
  await page.getByLabel("Phone (optional)").fill("+254712300001");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await expect(page.getByText("09:00").first()).toBeVisible();
  await page.getByRole("link", { name: "My appointments" }).first().click();
  await expect(page.getByText("Booked as Amina Wanjiku.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("the continue button stays disabled until a time is picked", async ({
  page,
}) => {
  await page.goto(`/book/${DOCTOR}?date=${dayAhead(4)}`);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByText("10:00", { exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue" })).toBeVisible();
});

async function bookAndWait(page: Page, startsAt: string, name?: string) {
  await bookThroughForm(page, startsAt, name);
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test("a double booking says the time was just taken and offers the next free times", async ({
  browser,
}) => {
  const day = dayAhead(5);
  const target = slot(day, "09:30");
  const a = await newPage(browser);
  const b = await newPage(browser);
  // Both people open the same slot; the first one books it.
  await b.page.goto(details(target));
  await bookThroughForm(a.page, target, "First Patient");
  await expect(
    a.page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();

  await b.page.getByLabel("Full name").fill("Second Patient");
  await b.page.getByRole("button", { name: "Confirm booking" }).click();
  const alert = alertOf(b.page);
  await expect(alert).toContainText("That time was just taken.");
  await expect(alert).toContainText("Here are the next free times");
  // A suggested time leads straight to a details page for that time, and it books.
  await alert.getByRole("link").first().click();
  await expect(b.page).toHaveURL(/\/details\?starts_at=/);
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
  await bookAndWait(page, slot(dayAhead(6), "09:00"));
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();
  await expect(
    page.getByText("cancelled", { exact: false }).first(),
  ).toBeVisible();
});

test("cancelling the same appointment twice reports that it is already cancelled", async ({
  page,
  context,
}) => {
  await bookAndWait(page, slot(dayAhead(7), "09:00"));
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
  const day = dayAhead(8);
  await bookAndWait(page, slot(day, "09:00"));
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await page.getByText("11:00", { exact: true }).click();
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(page).toHaveURL(/\/appointments\?rescheduled=1/);
  await expect(page.getByText("11:00").first()).toBeVisible();
});

test("a time that has already passed is refused with a plain message", async ({
  page,
}) => {
  await bookThroughForm(page, slot(dayAhead(-1), "09:00"));
  await expect(alertOf(page)).toContainText("That time has already passed.");
});

test("a time less than an hour away is refused with a plain message", async ({
  page,
}) => {
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  await bookThroughForm(page, soon);
  await expect(alertOf(page)).toContainText("at least an hour");
});

test("an invalid phone number is explained next to the field", async ({
  page,
}) => {
  await page.goto(details(slot(dayAhead(9), "09:00")));
  await page.getByLabel("Full name").fill("Test Patient");
  await page.getByLabel("Phone (optional)").fill("0712345678");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText("Use international format")).toBeVisible();
});

test("the booking screens never scroll sideways on a 360px phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  for (const path of [
    "/book",
    `/book/${DOCTOR}?date=${dayAhead(10)}`,
    details(slot(dayAhead(10), "09:00")),
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
