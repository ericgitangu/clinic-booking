import { expect, test } from "@playwright/test";
import { hhmm, pick } from "./api";
import { withDb } from "./support/db";
import { newPerson, sessionCookies } from "./support/auth";

// A visit that starts in less than an hour cannot be cancelled or moved. The API refuses it (the
// backend tests cover 59, 60 and 61 minutes); here the screen disables the actions and says why, and
// a request that slips through still gets plain words. The appointment is booked through the UI
// for a far-off time, then moved into the window in the database, as nothing public can book it.

// Each scenario books a visit for a fresh person and then moves it in the database to a time
// inside (or just outside) the last hour, because nothing public can book it there. Two scenarios
// share a doctor (4) but move to different times; moveTo frees a slot an earlier run left behind,
// so the file can be run again on the same database.
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
async function moveTo(
  originalStart: string,
  doctorId: string,
  minutesAhead: number,
) {
  // The half hour at or just before now + minutesAhead: 0 to 30 minutes earlier than that.
  await withDb(async (db) => {
    const slot = `date_trunc('hour', now() + make_interval(mins => $3))
        + CASE WHEN extract(minute FROM now() + make_interval(mins => $3)) >= 30
               THEN interval '30 minutes' ELSE interval '0' END`;
    // A rerun on the same database finds an earlier run's visit in that slot: free it first.
    await db.query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now(), cancellation_reason = 'e2e: slot reused'
        WHERE doctor_id = $2 AND starts_at = ${slot} AND starts_at <> $1::timestamptz
          AND status = 'booked'`,
      [originalStart, doctorId, minutesAhead],
    );
    await db.query(
      `UPDATE appointments
          SET starts_at = ${slot}, ends_at = ${slot} + interval '30 minutes'
        WHERE starts_at = $1::timestamptz AND doctor_id = $2 AND status = 'booked'`,
      [originalStart, doctorId, minutesAhead],
    );
  });
}

// 20 to 50 minutes away: inside the last hour.
const moveIntoWindow = (originalStart: string, doctorId: string) =>
  moveTo(originalStart, doctorId, 50);

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
    /less than an hour.*call the clinic/i,
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
    page.getByText(/less than an hour.*call the clinic/i).first(),
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
    "This visit starts in less than an hour, so it can no longer be cancelled or moved in the app. Please call the clinic.",
  );
  await context.close();
});

test("a cancel dialog left open when the visit comes within the hour closes and says why", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(
    browser,
    4,
    2,
  );
  // 70 to 100 minutes away: outside the hour when the page is drawn.
  await moveTo(startsAt, doctorId, 100);
  await page.clock.install({ time: new Date() });
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Why are you cancelling?")).toBeVisible();
  // 45 minutes pass with the dialog open; the page looks again every 30 seconds.
  await page.clock.fastForward(45 * 60_000);
  await expect(page.getByLabel("Why are you cancelling?")).toHaveCount(0);
  await expect(alertOf(page)).toContainText(
    "This visit now starts in less than an hour, so it can no longer be cancelled or moved.",
  );
  await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await context.close();
});

async function moveById(id: string, minutesAhead: number) {
  await withDb(async (db) => {
    const slot = `date_trunc('hour', now() + make_interval(mins => $2))
        + CASE WHEN extract(minute FROM now() + make_interval(mins => $2)) >= 30
               THEN interval '30 minutes' ELSE interval '0' END`;
    // Free the slot if an earlier run left one of this doctor's visits in it.
    await db.query(
      `UPDATE appointments
          SET status = 'cancelled', cancelled_at = now(), cancellation_reason = 'e2e: slot reused'
        WHERE starts_at = ${slot} AND status = 'booked' AND id <> $1
          AND doctor_id = (SELECT doctor_id FROM appointments WHERE id = $1)`,
      [id, minutesAhead],
    );
    await db.query(
      `UPDATE appointments
          SET starts_at = ${slot}, ends_at = ${slot} + interval '30 minutes'
        WHERE id = $1 AND status = 'booked'`,
      [id, minutesAhead],
    );
  });
}

test("a reschedule page left open across the boundary draws itself again and says why", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(
    browser,
    0,
    3,
  );
  await moveTo(startsAt, doctorId, 100); // 70 to 100 minutes away when the page is drawn
  await page.clock.install({ time: new Date() });
  await page.goto("/appointments");
  const href = await page
    .getByRole("link", { name: "Reschedule" })
    .getAttribute("href");
  const id = href!.split("/")[2];
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Reschedule" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move appointment" }),
  ).toBeVisible();
  // The visit is brought forward in the database (the server will now see it inside the hour) and
  // 45 minutes pass in the browser: the page's own check notices and asks for a fresh render.
  await moveById(id, 30);
  await page.clock.fastForward(45 * 60_000);
  await expect(
    page.getByText(/less than an hour.*call the clinic/i).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move appointment" }),
  ).toHaveCount(0);
  await context.close();
});

// A visit staff vetoed is locked: the API refuses a patient's change (APPOINTMENT_LOCKED) and the
// screen shows no change buttons at all, on the list, on the visit's page and on the reschedule URL.
// The lock is set in the database, as the staff veto does (staff_locked_at); there is no public way.
test("a visit the clinic locked shows 'Locked by the clinic' and no change buttons", async ({
  browser,
}) => {
  const { context, page, startsAt, doctorId } = await bookedPerson(
    browser,
    1,
    2,
  );
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await withDb((db) =>
    db.query(
      `UPDATE appointments SET staff_locked_at = now()
        WHERE starts_at = $1::timestamptz AND doctor_id = $2 AND status = 'booked'`,
      [startsAt, doctorId],
    ),
  );
  await page.goto("/appointments");
  const card = page
    .getByRole("listitem")
    .filter({ hasText: "Locked by the clinic" });
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
  await page.goto(`/appointments/${id}`);
  await expect(page.getByTestId("staff-lock")).toContainText(
    "Locked by the clinic",
  );
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
  await page.goto(`/appointments/${id}/reschedule`);
  await expect(
    page.getByRole("heading", { name: "Locked by the clinic" }),
  ).toBeVisible();
  await context.close();
});
