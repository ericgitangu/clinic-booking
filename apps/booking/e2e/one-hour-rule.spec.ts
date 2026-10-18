import { expect, test } from "@playwright/test";
import { pick } from "./api";
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
) {
  const { doctorId, slots } = await pick(0, { doctor });
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
  return { context, page, startsAt: slots[0], doctorId };
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

