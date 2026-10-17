import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { firstDoctor, hhmm, pick } from "./api";
import { newPerson, sessionCookies } from "./support/auth";

// Real stack: this app, the real API and database (docker compose), and a real Better Auth session
// for each person (only Google's own sign-in is stood in for, see support/auth.ts). Each scenario
// takes its own week from pick(n), so scenarios running in parallel never meet on a day.

// Next adds its own role=alert route announcer; ours are the ones inside the page.
const alertOf = (page: Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');
const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;

type Person = ReturnType<typeof newPerson>;

async function signedIn(browser: Browser, person: Person = newPerson()) {
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  return { context, page: await context.newPage(), person };
}

async function confirmBooking(page: Page, doctorId: string, startsAt: string) {
  await page.goto(details(doctorId, startsAt));
  await page.getByRole("button", { name: "Confirm booking" }).click();
}

async function bookAndWait(page: Page, doctorId: string, startsAt: string) {
  await confirmBooking(page, doctorId, startsAt);
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
}

async function closeAll(...contexts: BrowserContext[]) {
  for (const c of contexts) await c.close();
}

test("books a visit from the doctor list to the confirmation", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(0);
  const { context, page, person } = await signedIn(browser);
  await page.goto("/book");
  await expect(
    page.getByRole("heading", { level: 1, name: "Book a visit" }),
  ).toBeVisible();
  await page.locator(`a[href="/book/${doctorId}"]`).click();
  await page.goto(`/book/${doctorId}?date=${day}`);
  await page.getByText(hhmm(slots[0]), { exact: true }).click();
  await page.getByRole("link", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/details\?starts_at=/);
  await expect(page.getByText(`Booking as ${person.name}`)).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await expect(page.getByText(hhmm(slots[0])).first()).toBeVisible();
  await page.getByRole("link", { name: "My appointments" }).first().click();
  await expect(page.getByText(`Signed in as ${person.name}.`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await closeAll(context);
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
  const a = await signedIn(browser);
  const b = await signedIn(browser);
  // Both people open the same slot; the first one books it.
  await b.page.goto(details(doctorId, target));
  await bookAndWait(a.page, doctorId, target);

  await b.page.getByRole("button", { name: "Confirm booking" }).click();
  const alert = alertOf(b.page);
  await expect(alert).toContainText("That time was just taken.");
  await expect(alert).toContainText("Here are the next free times");
  // Slow the browser's navigation to the details page, as a busy runner or a bad connection would:
  // the confirm click must wait for the suggested time's page, never land on the old one.
  await b.page.route(/\/book\/[^/]+\/details/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const suggestion = alert.getByRole("link").first();
  const suggestedHref = await suggestion.getAttribute("href");
  await suggestion.click();
  // The page is already on a details URL (for the taken time), so wait for the suggested one.
  await expect(b.page).toHaveURL(
    (u) => u.pathname + u.search === suggestedHref,
  );
  await b.page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    b.page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await closeAll(a.context, b.context);
});

test("cancelling asks for a reason and moves the appointment out of Upcoming", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(3);
  const { context, page } = await signedIn(browser);
  await bookAndWait(page, doctorId, slots[0]);
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();
  await closeAll(context);
});

test("cancelling the same appointment twice reports that it is already cancelled", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(4);
  const { context, page } = await signedIn(browser);
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
  await closeAll(context);
});

test("rescheduling moves the appointment to the new time", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(5);
  const { context, page } = await signedIn(browser);
  await bookAndWait(page, doctorId, slots[0]);
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await page.getByText(hhmm(slots[2]), { exact: true }).click();
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(page).toHaveURL(/\/appointments\?rescheduled=1/);
  await expect(page.getByText(hhmm(slots[2])).first()).toBeVisible();
  await closeAll(context);
});

test("a time that has already passed is refused with a plain message", async ({
  browser,
}) => {
  const doctorId = await firstDoctor();
  const { context, page } = await signedIn(browser);
  await confirmBooking(
    page,
    doctorId,
    new Date(Date.now() - 86_400_000).toISOString(),
  );
  await expect(alertOf(page)).toContainText("That time has already passed.");
  await closeAll(context);
});

test("a time less than an hour away is refused with a plain message", async ({
  browser,
}) => {
  const doctorId = await firstDoctor();
  const { context, page } = await signedIn(browser);
  await confirmBooking(
    page,
    doctorId,
    new Date(Date.now() + 30 * 60_000).toISOString(),
  );
  await expect(alertOf(page)).toContainText("at least an hour");
  await closeAll(context);
});

test("someone who is not signed in is asked to sign in to book, and to see appointments", async ({
  page,
}) => {
  const { doctorId, slots } = await pick(6);
  await page.goto(details(doctorId, slots[0]));
  await expect(
    page.getByRole("heading", { name: "Sign in to book" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm booking" }),
  ).toHaveCount(0);
  await page.goto("/appointments");
  await expect(
    page.getByRole("button", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("the sign-in button sends the browser to Google with this site's callback", async ({
  page,
}) => {
  const { doctorId, slots } = await pick(6);
  // Google itself is not reachable from a test: stop the browser at the door and read where it was going.
  await page.route(/accounts\.google\.com/, (route) => route.abort());
  await page.goto(details(doctorId, slots[0]));
  const toGoogle = page.waitForRequest(/accounts\.google\.com/);
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  const url = new URL((await toGoogle).url());
  expect(url.searchParams.get("client_id")).toBe("e2e-google-client-id");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://localhost:3100/auth/callback/google",
  );
  expect(url.searchParams.get("scope")).toContain("email");
});

test("a booking is private to the person who made it", async ({ browser }) => {
  const { doctorId, slots } = await pick(7);
  const owner = await signedIn(browser);
  await bookAndWait(owner.page, doctorId, slots[0]);
  const appointmentId = owner.page.url().split("/").pop()!;

  // Someone else, signed in, cannot open it: the API answers 404 for it, as for an id that never existed.
  const stranger = await signedIn(browser);
  const other = await stranger.page.goto(`/book/confirmed/${appointmentId}`);
  expect(other?.status()).toBe(404);
  const move = await stranger.page.goto(
    `/appointments/${appointmentId}/reschedule`,
  );
  expect(move?.status()).toBe(404);
  await stranger.page.goto("/appointments");
  await expect(stranger.page.getByText("Nothing booked.")).toBeVisible();

  // Someone not signed in sees only the sign-in prompt, never the booking.
  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(`/book/confirmed/${appointmentId}`);
  await expect(
    visitorPage.getByRole("heading", { name: "Sign in to see your booking" }),
  ).toBeVisible();
  await expect(visitorPage.getByText(hhmm(slots[0]))).toHaveCount(0);

  // The owner still can.
  const own = await owner.page.goto(`/book/confirmed/${appointmentId}`);
  expect(own?.status()).toBe(200);
  await closeAll(owner.context, stranger.context, visitor);
});

test("the booking screens never scroll sideways on a 360px phone", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(8);
  const { context, page } = await signedIn(browser);
  const signedOut = await browser.newContext();
  const outPage = await signedOut.newPage();
  for (const p of [page, outPage])
    await p.setViewportSize({ width: 360, height: 740 });
  for (const [p, path] of [
    [page, "/book"],
    [page, `/book/${doctorId}?date=${day}`],
    [page, details(doctorId, slots[0])],
    [page, "/appointments"],
    [outPage, details(doctorId, slots[0])],
    [outPage, "/appointments"],
  ] as const) {
    await p.goto(path);
    const { scroll, inner } = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(inner);
  }
  await closeAll(context, signedOut);
});
