// Every surface opens a detail view when clicked, for every role. The detail is the API's own view
// of that person: a viewer sees initials, no actions, and "hidden for your role" where a reason is
// on record; an owner or admin sees the reasons and the actions, each of which asks for a reason.
import AxeBuilder from "@axe-core/playwright";
import {
  addDays,
  formatBucket,
  lastDays,
  localDate,
} from "../src/lib/clinic-time";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { internal, OWNER, publicApi } from "./support/stack";
import { expect, seeded, settle, tap, test } from "./support/fixtures";
import type { Page } from "@playwright/test";

const owner = { email: OWNER, role: "owner" };

async function openDashboard(page: Page, size = { width: 1280, height: 900 }) {
  await page.setViewportSize(size);
  await page.goto("/dashboard?days=14");
  await expect(page.getByTestId("today-board")).toBeVisible();
}

/** A visit of our own in the last hours, on the doctor no other spec books, so it is on the board. */
async function visitOnTheBoard(back: number): Promise<string> {
  const id = await bookOneStraightThroughTheApi();
  // Each caller its own half hour (all on the last doctor), inside the desk window of two hours.
  moveToPastHalfHour(id, back, false, true);
  return id;
}

const sheet = (page: Page) =>
  page.locator('[data-slot="sheet-content"]').last();

async function expectAsksForReason(
  page: Page,
  buttonName: string,
  title: RegExp,
) {
  await tap(sheet(page).getByRole("button", { name: buttonName }));
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Reason")).toBeVisible();
  // Nothing happens until a reason of at least 3 characters is given.
  const confirm = dialog.getByRole("button", { name: buttonName });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason").fill("ab");
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Reason").fill("abc");
  await expect(confirm).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

test.describe("a click opens the detail", () => {
  test("a Today board row opens its appointment, with the actions for an admin, each asking for a reason", async ({
    as,
  }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await visitOnTheBoard(3);
    const page = await as("admin");
    await openDashboard(page);
    const row = page
      .getByTestId("today-visit")
      .locator(`a[href$="/dashboard/appointments/${id}"]`);
    await tap(row);
    await expect(page.getByTestId("sheet-patient")).toBeVisible();
    const actions = page.getByTestId("sheet-actions");
    await expect(actions).toBeVisible();
    // In the desk window, so the marks are offered; every action opens the same dialog and wants a reason.
    await expectAsksForReason(page, "Mark arrived", /Mark as arrived\?/);
    await expectAsksForReason(page, "Mark no-show", /Mark as no-show\?/);
    await expect(page.getByTestId("sheet-patient")).toBeVisible(); // the sheet is still there
  });

  test("the same row opens for a viewer as detail only: initials, no actions", async ({
    as,
  }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await visitOnTheBoard(2);
    const page = await as("viewer");
    await openDashboard(page);
    await tap(
      page
        .getByTestId("today-visit")
        .locator(`a[href$="/dashboard/appointments/${id}"]`),
    );
    await expect(page.getByTestId("sheet-patient")).toBeVisible();
    await expect(page.getByTestId("sheet-actions")).toHaveCount(0);
    expect(await sheet(page).innerText()).not.toContain("E2E Cache Patient");
    for (const name of [
      "Mark arrived",
      "Mark no-show",
      "Reschedule",
      "Cancel appointment",
      "Veto and lock",
    ]) {
      await expect(sheet(page).getByRole("button", { name })).toHaveCount(0);
    }
  });

  test("a cancelled appointment shows its reason to an owner and says it is hidden for a viewer", async ({
    as,
  }) => {
    const id = seeded().cancelled;
    const reason = "patient called to cancel";
    const open = async (who: "owner" | "viewer") => {
      const page = await as(who);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/dashboard?status=cancelled");
      await tap(
        page
          .locator(`a[href$="/dashboard/appointments/${id}"]:visible`)
          .first(),
      );
      await expect(page.getByTestId("sheet-patient")).toBeVisible();
      return page;
    };
    const o = await open("owner");
    await expect(o.getByTestId("sheet-reasons")).toContainText(
      `Cancellation: ${reason}`,
    );
    await o.close();
  });

  test("the viewer's detail of that cancelled appointment has no reason text, only the note", async ({
    as,
  }) => {
    const id = seeded().cancelled;
    const page = await as("viewer");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard?status=cancelled");
    await tap(
      page.locator(`a[href$="/dashboard/appointments/${id}"]:visible`).first(),
    );
    await expect(page.getByTestId("sheet-patient")).toBeVisible();
    await expect(page.getByTestId("sheet-reason-note")).toHaveText(
      "Reason on record: hidden for your role.",
    );
    expect(await sheet(page).innerText()).not.toContain(
      "patient called to cancel",
    );
    await expect(page.getByTestId("sheet-actions")).toHaveCount(0);
  });

  test("a visit in a card's list opens its own sheet, and an admin finds Reschedule, Cancel and Veto asking for reasons", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const original = await publicApi<{ starts_at: string; doctor_id: string }>(
      "GET",
      `/appointments/${id}`,
    );
    const day = addDays(original.body.starts_at.slice(0, 10), 1);
    const avail = await publicApi<{ slots: { starts_at: string }[] }>(
      "GET",
      `/doctors/${original.body.doctor_id}/availability?date=${day}`,
    );
    const target = avail.body.slots[1];
    test.skip(!target, "no free time the next day to move to");
    await publicApi("PATCH", `/appointments/${id}/reschedule`, {
      starts_at: target!.starts_at,
    });

    const page = await as("admin");
    await openDashboard(page);
    await tap(page.getByRole("button", { name: /^Upcoming booked\b/ }));
    const link = page
      .getByTestId("drill-list")
      .locator(`a[href$="/appointments/${id}"]`);
    await expect(link).toBeVisible();
    await tap(link);
    await expect(page.getByTestId("sheet-patient")).toBeVisible();
    await expectAsksForReason(
      page,
      "Cancel appointment",
      /Cancel this appointment\?/,
    );
    await expectAsksForReason(
      page,
      "Veto and lock",
      /Undo the patient's last change\?/,
    );
    await tap(sheet(page).getByRole("button", { name: "Reschedule" }));
    const move = page.getByRole("dialog", { name: "Move this appointment" });
    await expect(move.getByLabel("Reason")).toBeVisible();
    await expect(
      move.getByRole("button", { name: "Move appointment" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  test("a free-slot row opens the slots of that gap", async ({ as }) => {
    const gaps = await internal<{ items: unknown[] }>(
      "GET",
      "/internal/admin/ops/gaps?hours=48",
      owner,
    );
    test.skip(
      gaps.body.items.length === 0,
      "no free slot in the next 48 hours at this time of day",
    );
    const page = await as("owner");
    await openDashboard(page);
    await tap(page.getByTestId("gap").first().getByTestId("gap-open"));
    const count = Number(
      await page.getByTestId("slots-count").getAttribute("data-count"),
    );
    expect(count).toBeGreaterThan(0);
    await expect(page.getByTestId("slots-list").locator("li")).toHaveCount(
      count,
    );
    await page.keyboard.press("Escape");
  });

  test("a reason row, an activity day and the Reschedules card each open their figures, and say what cannot be listed", async ({
    as,
  }) => {
    const r = lastDays(new Date(), 14);
    const reasons = await internal<{
      total: number;
      items: { category: string; count: number }[];
    }>(
      "GET",
      `/internal/admin/ops/cancellation-reasons?from=${r.from}&to=${r.to}`,
      owner,
    );
    const kpis = await internal<{
      reschedules: { value: number | null; previous: number | null };
    }>("GET", `/internal/admin/ops/kpis?from=${r.from}&to=${r.to}`, owner);
    const page = await as("owner");
    await openDashboard(page);
    // The activity series is cached for a minute; ask for the API's own before comparing with it.
    const button = page.getByTestId("refresh-metrics");
    const finished = Number(await button.getAttribute("data-refreshes"));
    await tap(button);
    await expect(button).toHaveAttribute(
      "data-refreshes",
      String(finished + 1),
    );
    await expect(button).toBeEnabled();

    // A reason row.
    const top = reasons.body.items
      .filter((i) => i.count > 0)
      .sort((a, b) => b.count - a.count)[0];
    test.skip(!top, "no cancellations to group");
    await tap(page.getByTestId("reason-row").first());
    await expect(page.getByTestId("figure-reason")).toContainText(
      `${top!.count} of ${reasons.body.total} cancelled`,
    );
    await expect(page.getByTestId("figure-gap")).toContainText(
      "cancellation date",
    );
    await page.keyboard.press("Escape");

    // The Reschedules card.
    await tap(page.getByRole("button", { name: /^Reschedules\b/ }));
    await expect(page.getByTestId("figure-reschedules")).toHaveText(
      `${kpis.body.reschedules.value ?? 0} now, ${kpis.body.reschedules.previous ?? 0} before.`,
    );
    await expect(page.getByTestId("figure-gap")).toBeVisible();
    await page.keyboard.press("Escape");

    // An activity day, from the numbers table: today's own row, as the API's series counts it.
    await page.getByText("Show the numbers as a table").click();
    const today = localDate(new Date());
    const metrics = await internal<{
      series: {
        bucket_start: string;
        booked: number;
        rescheduled: number;
        cancelled: number;
      }[];
    }>(
      "GET",
      `/internal/admin/metrics?from=${r.from}&to=${r.to}&bucket=day`,
      owner,
    );
    const p = metrics.body.series.find(
      (s) => s.bucket_start.slice(0, 10) === today,
    );
    await tap(
      page
        .getByTestId("activity-day")
        .filter({ hasText: formatBucket(`${today}T00:00:00`) }),
    );
    await expect(page.getByTestId("figure-activity")).toHaveText(
      `${p?.booked ?? 0} booked, ${p?.rescheduled ?? 0} rescheduled, ${p?.cancelled ?? 0} cancelled.`,
    );
    await expect(page.getByTestId("figure-gap")).toBeVisible();
  });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme, open modals`, () => {
    test.use({ colorScheme: scheme });

    test("the appointment sheet, a figure sheet and the free-slots sheet have no serious axe findings", async ({
      as,
    }) => {
      const id = await bookOneStraightThroughTheApi();
      const page = await as("owner");
      await openDashboard(page);
      const audit = async (label: string) => {
        // The real condition, not a pause: the theme class is what was asked for and nothing is
        // still animating, so colours are read as they will rest.
        await expect(page.locator("html")).toHaveClass(
          new RegExp(`\\b${scheme}\\b`),
        );
        await settle(page);
        const { violations } = await new AxeBuilder({ page })
          .withTags([
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22aa",
            "best-practice",
          ])
          .analyze();
        expect(
          violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map(
              (v) =>
                `${label} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
            ),
        ).toEqual([]);
      };

      await tap(page.getByRole("button", { name: /^Upcoming booked\b/ }));
      await tap(
        page
          .getByTestId("drill-list")
          .locator(`a[href$="/appointments/${id}"]`),
      );
      await expect(page.getByTestId("sheet-patient")).toBeVisible();
      await audit("appointment sheet");
      // And a confirmation dialog opened over the sheet.
      await tap(
        sheet(page).getByRole("button", { name: "Cancel appointment" }),
      );
      await expect(
        page.getByRole("dialog", { name: "Cancel this appointment?" }),
      ).toBeVisible();
      await audit("confirm dialog over the sheet");
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Cancel this appointment?" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("sheet-patient")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("drill-count")).toHaveCount(0);

      await tap(page.getByRole("button", { name: /^Reschedules\b/ }));
      await expect(page.getByTestId("figure-gap")).toBeVisible();
      await audit("figure sheet");
      await page.keyboard.press("Escape");

      const gap = page.getByTestId("slots-open");
      if ((await gap.count()) > 0) {
        await tap(gap);
        await expect(page.getByTestId("slots-list")).toBeVisible();
        await audit("slots sheet");
      }
    });
  });
}

test("the viewer's appointment sheet has no serious axe findings", async ({
  as,
}) => {
  const page = await as("viewer");
  await openDashboard(page);
  // Upcoming visits always exist (the seeding books them), so the sheet is never empty.
  await tap(page.getByRole("button", { name: /^Upcoming booked\b/ }));
  const first = page.getByTestId("drill-list").locator("li a").first();
  await expect(first).toBeVisible();
  await tap(first);
  await expect(page.getByTestId("sheet-patient")).toBeVisible();
  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
  expect(
    violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
      ),
  ).toEqual([]);
});
