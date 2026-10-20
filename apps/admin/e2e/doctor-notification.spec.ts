// The arrival email to the doctor, against the real stack (docker compose, profile "realtime"): the
// admin app built for production, the real API, Postgres and gateway. The one stand-in is Resend's
// HTTP API (support/mail.ts), which the app really calls. A visit is marked arrived and the
// notification row, the email the stand-in received, the toast and the appointment sheet are read.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { book } from "./support/live-book";
import { allowMailTo, mailTo, refuseMailTo } from "./support/mail";
import { EMAIL, internal, OWNER } from "./support/stack";
import { expect, settle, tap, test } from "./support/fixtures";

const OWNER_WHO = { email: OWNER, role: "owner" };
const ADMIN_WHO = { email: EMAIL.admin, role: "admin" };
// A deliverable-looking address on a name the sender does not treat as a demonstration (it refuses
// example.*, .test, .invalid, .localhost). It never leaves this machine: the app's email goes to
// the stand-in.
const DOCTOR_EMAIL = "doctor.e2e@clinic-e2e.org";

interface Notice {
  status: "pending" | "sent" | "failed" | "skipped";
  reason: string | null;
  attempts: number;
}

/** A booked visit inside the desk window, and the doctor it ended up with. */
async function visitAtTheDesk(label: string) {
  const made = await book(`${label} ${Date.now()}`);
  moveToPastHalfHour(made.id, 1);
  const row = await internal<{ doctor_id: string; patient_name: string }>(
    "GET",
    `/internal/admin/appointments/${made.id}`,
    OWNER_WHO,
  );
  expect(row.status).toBe(200);
  return { ...made, doctorId: row.body.doctor_id };
}

async function setDoctorEmail(doctorId: string, email: string | null) {
  const res = await internal(
    "PATCH",
    `/internal/admin/doctors/${doctorId}/email`,
    ADMIN_WHO,
    { email, reason: "the e2e doctor address" },
  );
  expect(res.status).toBe(200);
}

async function notice(id: string): Promise<Notice | null> {
  const res = await internal<Notice>(
    "GET",
    `/internal/admin/appointments/${id}/doctor-notification`,
    OWNER_WHO,
  );
  return res.status === 200 ? res.body : null;
}

async function arrive(id: string) {
  const res = await internal<{ doctor_notice: { status: string } | null }>(
    "POST",
    `/internal/admin/appointments/${id}/arrived`,
    ADMIN_WHO,
    { reason: "patient is at the desk" },
  );
  expect(res.status).toBe(200);
  return res.body;
}

/** Marks the visit arrived the way staff do, in the browser, so the app's own action tells the doctor. */
async function markInBrowser(page: Page, id: string) {
  await page.goto(`/dashboard/appointments/${id}`);
  await tap(page.getByRole("button", { name: "Mark arrived" }));
  const ask = page.getByRole("dialog", { name: "Mark as arrived?" });
  await ask.getByLabel("Reason").fill("patient is at the desk");
  await ask.getByRole("button", { name: "Mark arrived" }).click();
  await expect(page.getByText("Marked arrived.")).toBeVisible();
}

async function onDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("live-status")).toHaveAttribute(
    "data-status",
    "live",
  );
}

test.describe("the arrival email to the doctor", () => {
  test.skip(
    inFirstHourOfClinicDay(),
    "a past half hour falls on yesterday in the first hour of the clinic day",
  );

  test("an arrival emails the doctor once, the row says sent, and the toast says so", async ({
    as,
  }) => {
    test.setTimeout(90_000);
    const visit = await visitAtTheDesk("Doctor Email Sent");
    await setDoctorEmail(visit.doctorId, DOCTOR_EMAIL);
    const before = (await mailTo(DOCTOR_EMAIL)).sent.length;

    // Tab B shows the dashboard; the person marks the visit in tab A, the same browser.
    const tabB = await as("admin");
    await onDashboard(tabB);
    const tabA = await tabB.context().newPage();
    await tabA.goto(`/dashboard/appointments/${visit.id}`);
    await tap(tabA.getByRole("button", { name: "Mark arrived" }));
    const ask = tabA.getByRole("dialog", { name: "Mark as arrived?" });
    await ask.getByLabel("Reason").fill("patient is at the desk");
    await ask.getByRole("button", { name: "Mark arrived" }).click();

    // The toast is up within 2 seconds, and goes on to say what became of the email.
    const toast = tabB
      .locator("[data-sonner-toast]")
      .filter({ hasText: `Marked arrived: ${visit.name}` });
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toContainText("doctor emailed", { timeout: 10_000 });

    // The row says sent, and the stand-in received exactly one email, for the doctor.
    await expect
      .poll(async () => (await notice(visit.id))?.status)
      .toBe("sent");
    const mails = (await mailTo(DOCTOR_EMAIL)).sent.slice(before);
    expect(mails).toHaveLength(1);
    const mail = mails[0];
    expect(mail.subject).toMatch(/has arrived for/);
    // First name and last initial only: "Doctor Email Sent <number>" is read as Doctor S., and
    // neither the middle word nor the number is in it.
    const stamp = visit.name.split(" ").pop() as string;
    expect(mail.subject).toBe(
      `Doctor S. has arrived for ${mail.subject.split(" for ")[1]}`,
    );
    expect(mail.text).toContain("Doctor S.");
    for (const part of ["Email", stamp]) {
      expect(mail.text).not.toContain(part);
      expect(mail.subject).not.toContain(part);
    }
    expect(mail.text).not.toMatch(/\+254|@example|notes/i);
    expect(mail.text).toContain(`/dashboard/appointments/${visit.id}`);
    expect(mail.text).toContain("East Africa Time");

    // Marked arrived again in the browser (to no-show and back, which runs the same server action
    // twice): the row stays sent, one attempt, and the stand-in never sees a second email.
    const attempts = (await notice(visit.id))?.attempts;
    expect(attempts).toBe(1);
    await tabA.goto(`/dashboard/appointments/${visit.id}`);
    await tap(tabA.getByRole("button", { name: "Change to no-show" }));
    const flip = tabA.getByRole("dialog", { name: "Change to no-show?" });
    await flip.getByLabel("Reason").fill("left before being seen");
    await flip.getByRole("button", { name: "Change to no-show" }).click();
    await expect(tabA.getByText("Marked no-show.")).toBeVisible();
    await tap(tabA.getByRole("button", { name: "Change to arrived" }));
    const back = tabA.getByRole("dialog", { name: "Change to arrived?" });
    await back.getByLabel("Reason").fill("came back to the desk");
    await back.getByRole("button", { name: "Change to arrived" }).click();
    await expect(tabA.getByText(/^Marked arrived\./)).toBeVisible();
    await expect
      .poll(
        async () => (await mailTo(DOCTOR_EMAIL)).sent.slice(before).length,
        {
          timeout: 4000,
          intervals: [500],
        },
      )
      .toBe(1);
    // ...and stays one while anything that was going to run has had time to.
    await tabA.waitForTimeout(3000);
    expect((await mailTo(DOCTOR_EMAIL)).sent.slice(before)).toHaveLength(1);
    expect(await notice(visit.id)).toMatchObject({ status: "sent", attempts });
    await allowMailTo(DOCTOR_EMAIL);
    await setDoctorEmail(visit.doctorId, null);
  });

  test("a doctor with no address is not emailed, and the toast and the sheet say why", async ({
    as,
  }) => {
    test.setTimeout(90_000);
    const visit = await visitAtTheDesk("Doctor Email None");
    await setDoctorEmail(visit.doctorId, null);

    const page = await as("admin");
    await onDashboard(page);
    const body = await arrive(visit.id);
    expect(body.doctor_notice?.status).toBe("skipped");

    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: `Marked arrived: ${visit.name}` });
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toContainText("email not sent (no doctor email)", {
      timeout: 5000,
    });
    expect(await notice(visit.id)).toMatchObject({
      status: "skipped",
      reason: "no_email",
    });

    await page
      .getByTestId("live-event")
      .filter({ hasText: visit.name })
      .getByRole("link")
      .click();
    await expect(page.getByTestId("sheet-doctor-notice")).toContainText(
      "the doctor has no email address on file",
    );
  });

  test("a provider failure is recorded, and sending again from the sheet delivers it", async ({
    as,
  }) => {
    test.setTimeout(90_000);
    const visit = await visitAtTheDesk("Doctor Email Retry");
    const retryTo = `retry.${Date.now()}@clinic-e2e.org`;
    await setDoctorEmail(visit.doctorId, retryTo);
    await refuseMailTo(retryTo, 1);

    const page = await as("admin");
    await onDashboard(page);
    await markInBrowser(await page.context().newPage(), visit.id);
    // Nothing waits for the email: the failure is recorded after the response.
    await expect
      .poll(async () => (await notice(visit.id))?.status, { timeout: 15_000 })
      .toBe("failed");
    expect(await notice(visit.id)).toMatchObject({ attempts: 1 });
    expect((await mailTo(retryTo)).sent).toHaveLength(0);

    await page
      .getByTestId("live-event")
      .filter({ hasText: visit.name })
      .getByRole("link")
      .click();
    const line = page.getByTestId("sheet-doctor-notice");
    await expect(line).toContainText("could not be sent");
    await tap(line.getByRole("button", { name: "Send the email again" }));
    await expect
      .poll(async () => (await notice(visit.id))?.status, { timeout: 15_000 })
      .toBe("sent");
    expect(await notice(visit.id)).toMatchObject({ attempts: 2 });
    expect((await mailTo(retryTo)).sent).toHaveLength(1);
    await setDoctorEmail(visit.doctorId, null);
  });

  test("a viewer's toast has no patient and nothing about the doctor's email", async ({
    as,
  }) => {
    test.setTimeout(90_000);
    const visit = await visitAtTheDesk("Doctor Email Viewer");
    await setDoctorEmail(visit.doctorId, DOCTOR_EMAIL);
    const page = await as("viewer");
    const asked: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/dashboard/read/doctor-notice"))
        asked.push(r.url());
    });
    await onDashboard(page);
    await arrive(visit.id);
    const toast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Marked arrived" });
    await expect(toast.first()).toBeVisible({ timeout: 2000 });
    // Past the first look an owner's toast makes (2.5 s) and still on screen (toasts last 6 s).
    await page.waitForTimeout(4000);
    const text = (
      await toast.first().innerText({ timeout: 1500 })
    ).toLowerCase();
    expect(text).not.toContain(visit.name.toLowerCase());
    expect(text).not.toContain("email");
    expect(text).not.toContain("doctor.e2e");
    // Then past the last look (15 s): the page never asked about the email.
    await page.waitForTimeout(13_000);
    // A viewer's page never asks about the email, and never carried the address.
    expect(asked).toEqual([]);
    expect(await page.content()).not.toContain(DOCTOR_EMAIL);
    await setDoctorEmail(visit.doctorId, null);
  });

  test("an owner or admin sets and removes a doctor's address on the doctor's card", async ({
    as,
  }) => {
    test.setTimeout(90_000);
    const page = await as("admin");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const card = page.getByTestId("doctor-email").first();
    await expect(card).toBeVisible();
    await tap(card.getByTestId("doctor-email-set"));
    const dialog = page.getByRole("dialog");
    const input = dialog.getByLabel("Doctor's email address");
    await input.fill("name @clinic.org");
    await expect(dialog.getByRole("alert")).toContainText("Remove the spaces");
    await expect(
      dialog.getByRole("button", { name: "Save email" }),
    ).toBeDisabled();
    await input.fill("Doctor.One@Clinic-E2E.org");
    await dialog.getByLabel("Reason").fill("the clinic's official address");
    await dialog.getByRole("button", { name: "Save email" }).click();
    await expect(page.getByText("The doctor's email was saved.")).toBeVisible();
    await expect(card.getByTestId("doctor-email-value")).toHaveText(
      "doctor.one@clinic-e2e.org",
    );

    await tap(card.getByRole("button", { name: /^Remove arrival email for/ }));
    const remove = page.getByRole("dialog");
    await remove.getByLabel("Reason").fill("the address is changing");
    await remove.getByRole("button", { name: "Remove email" }).click();
    await expect(
      page.getByText("The doctor's email was removed."),
    ).toBeVisible();
    await expect(card.getByTestId("doctor-email-value")).toContainText(
      "not set",
    );
  });

  test("a viewer has no field and the address is not on their board", async ({
    as,
  }) => {
    const page = await as("viewer");
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-board")).toBeVisible();
    await expect(page.getByTestId("doctor-email")).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${scheme} theme`, () => {
      test.use({ colorScheme: scheme });

      const rules = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
      const serious = async (page: Page, include: string) => {
        await settle(page);
        const { violations } = await new AxeBuilder({ page })
          .include(include)
          .withTags(rules)
          .analyze();
        return violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.help}`)
          .join("\n");
      };

      test("the appointment sheet with the doctor line has no serious or critical violations", async ({
        as,
      }) => {
        test.setTimeout(90_000);
        const visit = await visitAtTheDesk(`Doctor Email Axe ${scheme}`);
        await setDoctorEmail(visit.doctorId, null);
        const page = await as("admin");
        await page.setViewportSize({ width: 1280, height: 900 });
        await onDashboard(page);
        await arrive(visit.id);
        await page
          .getByTestId("live-event")
          .filter({ hasText: visit.name })
          .getByRole("link")
          .click();
        await expect(page.getByTestId("sheet-doctor-notice")).toBeVisible();
        expect(await serious(page, '[role="dialog"]')).toBe("");
      });

      test("the doctor email field has no serious or critical violations", async ({
        as,
      }) => {
        const page = await as("admin");
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("/dashboard");
        await tap(page.getByTestId("doctor-email-set").first());
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("Doctor's email address").fill("no at sign");
        await expect(dialog.getByRole("alert")).toBeVisible();
        expect(await serious(page, '[role="dialog"]')).toBe("");
      });
    });
  }
});
