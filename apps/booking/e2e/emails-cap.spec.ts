import { expect, test } from "./support/csp-guard";
import { pick } from "./api";
import { newPerson, sessionCookies } from "./support/auth";
import { withDb } from "./support/db";
import { mailTo } from "./support/stack";

// Runs on its own, after every other scenario (see playwright.config.ts): while the allowance is at
// its limit, any other scenario's email would be dropped. Real app, API and database; the only
// stand-in is Resend's HTTP API, which must receive nothing.
test("with the day's email allowance used up, a booking still goes through and no email is sent", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(4, { doctor: 1 });
  const person = newPerson();
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  const page = await context.newPage();
  await withDb((db) =>
    db.query(
      `INSERT INTO email_counter (day, sent) VALUES ((now() AT TIME ZONE 'UTC')::date, 2000000000)
       ON CONFLICT (day) DO UPDATE SET sent = 2000000000`,
    ),
  );
  try {
    await page.goto(
      `/book/${doctorId}/details?starts_at=${encodeURIComponent(slots[0])}`,
    );
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(
      page.getByRole("heading", { name: "You are booked" }),
    ).toBeVisible();
    // The email step runs after the response: give it time to have asked and been refused.
    await page.waitForTimeout(2_000);
    const mail = await mailTo(person.email);
    expect(mail.sent).toHaveLength(0);
    expect(mail.attempts).toBe(0); // it never even reached the provider
  } finally {
    await withDb((db) =>
      db.query(
        `DELETE FROM email_counter WHERE day = (now() AT TIME ZONE 'UTC')::date`,
      ),
    );
    await context.close();
  }
});
