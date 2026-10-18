import { expect, test } from "@playwright/test";
import { hhmm, pick } from "./api";
import { withDb } from "./support/db";
import { newPerson, sessionCookies } from "./support/auth";

// A visit that starts in less than an hour cannot be cancelled or moved. The API refuses it (the
// backend tests cover 59, 60 and 61 minutes); here the screen hides the actions and says why, and
// a request that slips through still gets plain words. The appointment is booked through the UI
// for a far-off time, then moved into the window in the database, as nothing public can book it.

// Each scenario uses a doctor of its own (2, 3, 4): the appointment is moved to the next half hour,
// and one doctor cannot hold two bookings at the same time.
async function bookedPerson(
  browser: import("@playwright/test").Browser,
  doctor: number,
  week = 0,
) {
  const { doctorId, slots } = await pick(week, { doctor });
  const person = newPerson();
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  const page = await context.newPage();
  await page.goto(
    `/book/${doctorId}/details?starts_at=${encodeURIComponent(slots[0])}`,
  );
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  return { context, page, startsAt: slots[0], doctorId, slots };
}

// The next :00 or :30 boundary that is 20 to 50 minutes away: on the grid, inside the window.
async function moveIntoWindow(originalStart: string, doctorId: string) {
  await withDb(async (db) => {
    await db.query(
      `UPDATE appointments
          SET starts_at = date_trunc('hour', now() + interval '50 minutes')
                          + CASE WHEN extract(minute FROM now() + interval '50 minutes') >= 30
                                 THEN interval '30 minutes' ELSE interval '0' END,
              ends_at = date_trunc('hour', now() + interval '50 minutes')
                          + CASE WHEN extract(minute FROM now() + interval '50 minutes') >= 30
                                 THEN interval '30 minutes' ELSE interval '0' END
                          + interval '30 minutes'
        WHERE starts_at = $1::timestamptz AND doctor_id = $2 AND status = 'booked'`,
      [originalStart, doctorId],
    );
  });
}

test("inside the last hour, cancel and reschedule are disabled and say why", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(browser, 2);
  await moveIntoWindow(startsAt, doctorId);
  await page.goto("/appointments");
  const cancel = page.getByRole("button", { name: "Cancel" });
  const reschedule = page.getByRole("button", { name: "Reschedule" });
  await expect(cancel).toBeDisabled();
  await expect(reschedule).toBeDisabled();
  // The reason is visible text, tied to both controls: not a hover-only tooltip.
  const note = page.getByText(/starts in less than an hour/i);
  await expect(note).toBeVisible();
  const noteId = await note.getAttribute("id");
  expect(noteId).toBeTruthy();
  await expect(cancel).toHaveAttribute("aria-describedby", noteId!);
  await expect(reschedule).toHaveAttribute("aria-describedby", noteId!);
  await context.close();
});

test("the reschedule page for a visit inside the last hour explains instead of offering times", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(browser, 3);
  await page.goto("/appointments");
  const href = await page
    .getByRole("link", { name: "Reschedule" })
    .getAttribute("href");
  expect(href).toMatch(/\/appointments\/.+\/reschedule/);
  await moveIntoWindow(startsAt, doctorId);
  await page.goto(href!);
  await expect(page.getByRole("status")).toContainText(
    /less than an hour.*contact the clinic/i,
  );
  await expect(page.getByRole("button", { name: /confirm|move/i })).toHaveCount(
    0,
  );
  await context.close();
});

test("a cancel that slips through the window is refused in plain words", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(browser, 4);
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  // The page was rendered while the visit was still outside the hour; it enters the window now.
  await moveIntoWindow(startsAt, doctorId);
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(
    page.getByText(/less than an hour.*contact the clinic/i).first(),
  ).toBeVisible();
  await context.close();
});


const alertOf = (page: import("@playwright/test").Page) =>
  page.locator('[role="alert"]:not(#__next-route-announcer__)');

test("moving a visit to a time under an hour away says so in plain words (BOOKING_TOO_SOON)", async ({
  browser,
}) => {
  const { context, page, slots } = await bookedPerson(browser, 0, 1);
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  // The grid never offers a too-soon time, so swap the chosen one for a time 30 minutes away in the
  // request, the way a hand-made request would.
  const picked = slots[2];
  const tooSoon = new Date(Date.now() + 30 * 60_000).toISOString();
  await page.route("**/appointments/**", async (route) => {
    const req = route.request();
    const raw = req.postDataBuffer();
    if (req.method() === "POST" && req.headers()["next-action"] && raw) {
      const body = raw.toString("utf8");
      expect(body, "the request carries the picked time").toContain(picked);
      return route.continue({ postData: body.replaceAll(picked, tooSoon) });
    }
    return route.continue();
  });
  await page.getByText(hhmm(slots[2]), { exact: true }).click();
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(alertOf(page)).toContainText(
    "Appointments need at least an hour's notice. Pick a later time.",
  );
  await context.close();
});

test("moving a visit that now starts within the hour says so in plain words (CHANGE_TOO_LATE)", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId, slots } = await bookedPerson(
    browser,
    1,
    1,
  );
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await page.getByText(hhmm(slots[2]), { exact: true }).click();
  // The page was drawn while the visit was still far off; it enters the last hour now.
  await moveIntoWindow(startsAt, doctorId);
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(alertOf(page)).toContainText(
    "This visit starts in less than an hour, so it can no longer be cancelled or moved. Please contact the clinic.",
  );
  await context.close();
});
