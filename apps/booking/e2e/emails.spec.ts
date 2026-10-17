import { expect, test, type Browser, type Page } from "@playwright/test";
import { addDays, hhmm, pick } from "./api";
import { newPerson, sessionCookies, type Person } from "./support/auth";
import {
  allowMailTo,
  mailTo,
  refuseMailTo,
  runReminders,
} from "./support/stack";

// Slots: the ack scenarios use the second doctor in the weeks the booking specs use for the first,
// and the reminder scenarios have days of their own in a week no other spec uses (a reminder run
// claims everything on its date, so no other spec may book on those dates).
//
// Real app, real API and database, real Better Auth sessions. The only stand-in is Resend's HTTP
// API (e2e/support/resend-standin.mjs), which the app really calls over HTTP. Each scenario reads
// only the mail sent to its own person, so scenarios can run in parallel.

const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;

async function signedIn(browser: Browser, person: Person = newPerson()) {
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  return { context, page: await context.newPage(), person };
}

async function book(
  page: Page,
  doctorId: string,
  startsAt: string,
): Promise<string> {
  await page.goto(details(doctorId, startsAt));
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  return page.url().split("/").pop()!;
}

// Mail is sent after the booking answered, in the same request: poll briefly for it.
async function waitForMail(email: string, count: number) {
  await expect
    .poll(async () => (await mailTo(email)).sent.length, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
  return (await mailTo(email)).sent;
}

test("booking, moving and cancelling each send the person an email", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(0, { doctor: 1 });
  const { context, page, person } = await signedIn(browser);
  const id = await book(page, doctorId, slots[0]);

  let mail = await waitForMail(person.email, 1);
  const booked = mail[0];
  expect(booked.from).toBe(
    "Idyllic Clinic Booking <reminders@ericgitangu.com>",
  );
  expect(booked.reply_to).toBe("developer.ericgitangu@gmail.com");
  expect(booked.subject).toContain("Your appointment is booked");
  expect(booked.subject).toContain(hhmm(slots[0]));
  expect(booked.text).toContain(hhmm(slots[0]));
  expect(booked.text).toContain("Nairobi time");
  expect(booked.html).toContain("<html");
  expect(booked.idempotency_key).toMatch(new RegExp(`^ack/${id}/booked/\\d+$`));

  // move it
  await page.goto("/appointments");
  await page.getByRole("link", { name: "Reschedule" }).click();
  await page.getByText(hhmm(slots[2]), { exact: true }).click();
  await page.getByRole("button", { name: "Move appointment" }).click();
  await expect(page).toHaveURL(/rescheduled=1/);
  mail = await waitForMail(person.email, 2);
  const moved = mail.find((m) => m.subject.includes("was moved"))!;
  expect(moved.subject).toContain(hhmm(slots[2]));
  expect(moved.text).toContain("Was:");
  expect(moved.text).toContain(hhmm(slots[0]));
  expect(moved.idempotency_key).toMatch(
    new RegExp(`^ack/${id}/rescheduled/\\d+$`),
  );
  expect(moved.idempotency_key).not.toBe(booked.idempotency_key);

  // cancel it, with a reason
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();
  mail = await waitForMail(person.email, 3);
  const cancelled = mail.find((m) => m.subject.includes("was cancelled"))!;
  expect(cancelled.text).toContain("Plans changed");
  expect(cancelled.idempotency_key).toMatch(
    new RegExp(`^ack/${id}/cancelled/\\d+$`),
  );
  expect(new Set(mail.map((m) => m.idempotency_key)).size).toBe(3);
  await context.close();
});

test("a person's name and address are escaped in the email", async ({
  browser,
}) => {
  const { doctorId, slots } = await pick(1, { doctor: 1 });
  const { context, page, person } = await signedIn(
    browser,
    newPerson({ name: "Pat <b>Bold</b> & Co" }),
  );
  await book(page, doctorId, slots[0]);
  const [mail] = await waitForMail(person.email, 1);
  expect(mail.html).not.toContain("<b>Bold</b>");
  expect(mail.html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
  expect(mail.text).toContain("Pat <b>Bold</b> & Co");
  await context.close();
});

test("an email Resend refuses never fails the booking", async ({ browser }) => {
  const { doctorId, slots } = await pick(2, { doctor: 1 });
  const { context, page, person } = await signedIn(browser);
  await refuseMailTo(person.email, 500);
  try {
    await book(page, doctorId, slots[0]); // the booking succeeds although the acknowledgement is refused
    await expect
      .poll(async () => (await mailTo(person.email)).attempts)
      .toBeGreaterThanOrEqual(1);
    expect((await mailTo(person.email)).sent).toHaveLength(0);
  } finally {
    await allowMailTo(person.email);
  }
  await context.close();
});

test("the daily reminder run emails tomorrow's appointment once, and a repeat sends nothing", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(9, { dayOffset: 0 });
  const { context, page, person } = await signedIn(browser);
  const id = await book(page, doctorId, slots[0]);
  await waitForMail(person.email, 1); // the acknowledgement

  // Rehearse the run for that clinic-local date, as the scheduled run does for "tomorrow".
  const first = await runReminders(day);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    date: day,
    claimed: 1,
    sent: 1,
    failed: 0,
  });
  const mail = (await mailTo(person.email)).sent.find((m) =>
    m.subject.startsWith("Reminder"),
  )!;
  expect(mail.subject).toContain(hhmm(slots[0]));
  expect(mail.text.toLowerCase()).toContain("your appointment is tomorrow");
  expect(mail.idempotency_key).toBe(
    `reminder/${id}/${Math.floor(Date.parse(slots[0]) / 1000)}`,
  );

  const again = await runReminders(day);
  expect(again.body).toMatchObject({ claimed: 0, sent: 0 });
  expect(
    (await mailTo(person.email)).sent.filter((m) =>
      m.subject.startsWith("Reminder"),
    ),
  ).toHaveLength(1);
  await context.close();
});

test("a reminder Resend keeps refusing is retried in the run, then left unsent under its lease", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(9, { dayOffset: 1 });
  const { context, page, person } = await signedIn(browser);
  await book(page, doctorId, slots[0]);
  await waitForMail(person.email, 1);

  await refuseMailTo(person.email, 500);
  try {
    const run = await runReminders(day);
    // tried again twice inside the run, with a pause, and never marked sent
    expect(run.body).toMatchObject({
      claimed: 1,
      sent: 0,
      failed: 1,
      retried: 2,
    });
  } finally {
    await allowMailTo(person.email);
  }
  const mail = await mailTo(person.email);
  expect(
    mail.sent.filter((m) => m.subject.startsWith("Reminder")),
  ).toHaveLength(0);
  expect(mail.attempts).toBeGreaterThanOrEqual(4); // the acknowledgement plus three tries
  // Resend works again, but the claim is still inside its 15-minute lease, so a double delivery of
  // the schedule cannot send it now (the lease expiring is covered in the backend tests).
  const retry = await runReminders(day);
  expect(retry.body).toMatchObject({ claimed: 0, sent: 0 });
  await context.close();
});

test("a reminder Resend refuses once is retried in the same run and sent", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(9, { dayOffset: 2 });
  const { context, page, person } = await signedIn(browser);
  const id = await book(page, doctorId, slots[0]);
  await waitForMail(person.email, 1);
  const before = (await mailTo(person.email)).attempts;

  await refuseMailTo(person.email, 503, 1); // only the next try is refused
  try {
    const run = await runReminders(day);
    expect(run.body).toMatchObject({
      claimed: 1,
      sent: 1,
      failed: 0,
      retried: 1,
    });
  } finally {
    await allowMailTo(person.email);
  }
  const mail = await mailTo(person.email);
  const reminders = mail.sent.filter((m) => m.subject.startsWith("Reminder"));
  expect(reminders).toHaveLength(1);
  expect(reminders[0].idempotency_key).toBe(
    `reminder/${id}/${Math.floor(Date.parse(slots[0]) / 1000)}`,
  );
  expect(mail.attempts - before).toBe(2); // the refused try and the one that went through
  await context.close();
});

test("the reminder route refuses anyone without the secret", async () => {
  const day = addDays(new Date().toISOString().slice(0, 10), 40);
  expect((await runReminders(day, null)).status).toBe(401);
  expect(
    (await runReminders(day, "not-the-secret-not-the-secret")).status,
  ).toBe(401);
});
