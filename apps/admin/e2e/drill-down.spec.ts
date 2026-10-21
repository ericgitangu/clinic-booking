// The drill-down sheets behind the key numbers and the sections, against the real API: every sheet
// opens on exactly the number it was opened from, and the count above its list is the count of the
// rows in it. Nothing here is a hard-coded figure; each expected number is read from the API.
import { lastDays, localDate } from "../src/lib/clinic-time";
import { bookOneStraightThroughTheApi } from "./support/booking";
import {
  pastHalfHourCanFallOnYesterday,
  moveToPastHalfHour,
} from "./support/clock";
import { EMAIL, internal, OWNER } from "./support/stack";
import { expect, tap, test } from "./support/fixtures";
import type { Page } from "@playwright/test";

const owner = { email: OWNER, role: "owner" };
const DAYS = 14;

interface Kpis {
  counts: {
    booked: number;
    cancelled: number;
    arrived: number;
    no_show: number;
  };
}

async function kpis(): Promise<Kpis["counts"]> {
  const r = lastDays(new Date(), DAYS);
  const res = await internal<Kpis>(
    "GET",
    `/internal/admin/ops/kpis?from=${r.from}&to=${r.to}`,
    owner,
  );
  expect(res.status).toBe(200);
  return res.body.counts;
}

async function openDashboard(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/dashboard?days=${DAYS}`);
  await expect(page.getByTestId("today-board")).toBeVisible();
}

const card = (page: Page, label: string) =>
  page.getByRole("button", { name: new RegExp(`^${label}\\b`) });

/** Presses Refresh and waits until that refresh has finished (the button counts finished ones). */
async function refresh(page: Page) {
  const button = page.getByTestId("refresh-metrics");
  const finished = Number(await button.getAttribute("data-refreshes"));
  await tap(button);
  await expect(button).toHaveAttribute("data-refreshes", String(finished + 1));
  await expect(button).toBeEnabled();
}

async function expectSheetCount(page: Page, expected: number) {
  await expect(page.getByTestId("drill-count")).toHaveAttribute(
    "data-count",
    String(expected),
  );
  if (expected > 0) {
    await expect(page.getByTestId("drill-list").locator("li")).toHaveCount(
      expected,
    );
  } else {
    await expect(page.getByTestId("drill-empty")).toBeVisible();
  }
}

test.describe("key number cards", () => {
  test("each card opens the visits behind it, and the count is the number it was opened from", async ({
    as,
  }) => {
    const c = await kpis();
    const page = await as("owner");
    await openDashboard(page);
    for (const [label, expected] of [
      ["Cancelled visits", c.cancelled],
      ["Fill rate", c.booked],
      ["Utilisation", c.arrived],
      ["Cancellation rate", c.cancelled],
      ["No-show rate", c.no_show],
      ["Median lead time", c.booked],
    ] as const) {
      const trigger = card(page, label);
      await tap(trigger);
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectSheetCount(page, expected);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused(); // focus goes back to what opened it
    }
  });

  test("Cancelled visits shows its own number, and Upcoming booked agrees once refreshed", async ({
    as,
  }) => {
    const c = await kpis();
    const page = await as("owner");
    await openDashboard(page);
    await expect(page.getByTestId("kpi-cancelled-visits")).toHaveText(
      String(c.cancelled),
    );
    // The upcoming figure is cached for a minute; Refresh asks the API again, and then the card
    // and the sheet (read live) must say the same.
    await refresh(page);
    const trigger = card(page, "Upcoming booked");
    const shown = Number(
      await page.getByTestId("kpi-upcoming-booked").innerText(),
    );
    await tap(trigger);
    await expectSheetCount(page, shown);
  });

  test("the sheet is a labelled dialog that keeps focus inside and closes on Escape", async ({
    as,
  }) => {
    const page = await as("owner");
    await openDashboard(page);
    await tap(card(page, "Fill rate"));
    const dialog = page.getByRole("dialog", { name: "Booked visits" });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        document
          .querySelector('[role="dialog"]')
          ?.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("status and doctor narrow the list, and the count follows the rows", async ({
    as,
  }) => {
    const c = await kpis();
    const page = await as("owner");
    await openDashboard(page);
    await tap(card(page, "Fill rate"));
    await expectSheetCount(page, c.booked);
    // Opened on All booked visits; "Booked" keeps those not yet marked, "Arrived" the marked ones.
    for (const [value, label] of [
      ["arrived", "Arrived"],
      ["no_show", "No-show"],
      ["cancelled", "Cancelled"],
    ] as const) {
      await page.getByLabel("Status").selectOption(value);
      const n = await page.getByTestId("drill-list").locator("li").count();
      await expect(page.getByTestId("drill-count")).toHaveAttribute(
        "data-count",
        String(n),
      );
      if (n > 0) {
        await expect(
          page.getByTestId("drill-list").getByText(label, { exact: true }),
        ).toHaveCount(n);
      }
    }
    await page.getByLabel("Status").selectOption("all");
    const doctors = await page.getByLabel("Doctor").locator("option").all();
    if (doctors.length > 1) {
      await page.getByLabel("Doctor").selectOption({ index: 1 });
      const n = await page.getByTestId("drill-list").locator("li").count();
      await expect(page.getByTestId("drill-count")).toHaveAttribute(
        "data-count",
        String(n),
      );
      expect(n).toBeLessThanOrEqual(c.booked);
    }
  });

  test("a row opens its appointment", async ({ as }) => {
    test.skip(
      pastHalfHourCanFallOnYesterday(8),
      "a past half hour can fall on yesterday just after the clinic's midnight",
    );
    // A visit of our own in the last hours, so the list is never empty whatever ran before.
    const own = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(own, 4);
    const page = await as("owner");
    await openDashboard(page);
    await tap(card(page, "Fill rate"));
    const first = page.getByTestId("drill-list").locator("li a").first();
    const name = (
      await first.locator("span.truncate").first().innerText()
    ).trim();
    await first.click();
    // The row opens that appointment in its own sheet over the list.
    await expect(page.getByTestId("sheet-patient")).toHaveText(name);
  });

  test("on a 360px phone the sheet is a bottom sheet that fits the screen", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/dashboard?days=${DAYS}`);
    await expect(page.getByTestId("today-board")).toBeVisible();
    await tap(card(page, "Fill rate"));
    const sheet = page.locator(
      '[data-slot="sheet-content"][data-side="bottom"]',
    );
    await expect(sheet).toBeVisible();
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== "running"),
    );
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.x)).toBeGreaterThanOrEqual(0);
    expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(360);
    expect(Math.round(box.y + box.height)).toBe(780); // sits on the bottom edge
    expect(box.height).toBeLessThanOrEqual(780 * 0.9);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a viewer's sheet shows the API's initials, not names", async ({
    as,
  }) => {
    const page = await as("viewer");
    await openDashboard(page);
    await tap(card(page, "Fill rate"));
    await expect(page.getByTestId("drill-count")).toHaveAttribute(
      "data-count",
      /\d+/,
    );
    expect(await page.getByRole("dialog").innerText()).not.toContain(
      "E2E Patient",
    );
  });
});

test.describe("sections", () => {
  test("a doctor's load and a peak-hours cell open lists whose counts match", async ({
    as,
  }) => {
    // Data of our own: a booked visit and a cancelled one in the last few hours, so every section
    // has something to open.
    const booked = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(booked, 4);
    const cancelled = await bookOneStraightThroughTheApi();
    const done = await internal(
      "PATCH",
      `/internal/admin/appointments/${cancelled}/cancel`,
      owner,
      { reason: "no transport to get there" },
    );
    expect(done.status).toBe(200);
    moveToPastHalfHour(cancelled, 5, true);

    const page = await as("owner");
    await openDashboard(page);
    // Make sure the cached figures are the API's own.
    await refresh(page);

    const r = lastDays(new Date(), DAYS);
    const metrics = await internal<{
      per_doctor: { name: string; booked_visits: number }[];
    }>(
      "GET",
      `/internal/admin/metrics?from=${r.from}&to=${r.to}&bucket=day`,
      owner,
    );
    const withVisits = metrics.body.per_doctor.find(
      (d) => d.booked_visits > 0,
    )!;
    expect(withVisits).toBeTruthy();
    await tap(
      page
        .getByTestId("utilisation-list")
        .locator("li", { hasText: withVisits.name })
        .getByRole("button"),
    );
    await expectSheetCount(page, withVisits.booked_visits);
    await page.keyboard.press("Escape");

    const heat = await internal<{
      cells: { weekday: number; hour: number; count: number }[];
    }>("GET", `/internal/admin/ops/heatmap?from=${r.from}&to=${r.to}`, owner);
    const cell = heat.body.cells.find((c) => c.count > 0)!;
    expect(cell).toBeTruthy();
    const day = [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ][cell.weekday - 1]!;
    await tap(
      page.getByRole("button", {
        name: new RegExp(
          `^${cell.count} visits? on ${day}s at ${String(cell.hour).padStart(2, "0")}:00`,
        ),
      }),
    );
    await expectSheetCount(page, cell.count);
  });

  test("a doctor's day on the Today board opens that doctor's visits, as the API counts them", async ({
    as,
  }) => {
    const today = localDate(new Date());
    const board = await internal<{
      doctors: { doctor_id: string; appointments: unknown[] }[];
    }>("GET", `/internal/admin/ops/today?date=${today}`, owner);
    const busy = board.body.doctors.find((d) => d.appointments.length > 0);
    test.skip(!busy, "no doctor has a visit today at this time");
    const page = await as("owner");
    await openDashboard(page);
    await tap(
      page
        .getByTestId(`today-${busy!.doctor_id}`)
        .getByTestId("today-drill")
        .locator(".."),
    );
    await expectSheetCount(page, busy!.appointments.length);
  });
});

test.describe("the Today figures and the free slots", () => {
  test("the Today card and each figure in the totals line open exactly that many visits", async ({
    as,
  }) => {
    // A visit of our own in the last hours, so there is something to count today.
    test.skip(
      pastHalfHourCanFallOnYesterday(8),
      "a past half hour can fall on yesterday just after the clinic's midnight",
    );
    const own = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(own, 6);

    const today = localDate(new Date());
    const board = await internal<{
      totals: {
        booked: number;
        arrived: number;
        no_show: number;
        cancelled: number;
      };
    }>("GET", `/internal/admin/ops/today?date=${today}`, owner);
    const t = board.body.totals;
    const all = t.booked + t.arrived + t.no_show + t.cancelled;
    expect(all).toBeGreaterThan(0);

    const page = await as("owner");
    await openDashboard(page);
    // The card's own number is the API's, and the sheet agrees with it.
    await expect(page.getByTestId("kpi-today")).toHaveText(String(all));
    const trigger = card(page, "Today");
    await tap(trigger);
    await expectSheetCount(page, all);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    const line = page.getByTestId("today-totals");
    for (const [word, n] of [
      ["booked", t.booked],
      ["arrived", t.arrived],
      ["no-show", t.no_show],
      ["cancelled", t.cancelled],
    ] as const) {
      const button = line.getByRole("button", { name: `${n} ${word}` });
      await tap(button);
      await expectSheetCount(page, n);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  });

  test("the free-slots sheet lists exactly the API's slots, and a doctor narrows it", async ({
    as,
  }) => {
    const gaps = await internal<{
      items: { doctor_id: string }[];
    }>("GET", "/internal/admin/ops/gaps?hours=48", owner);
    test.skip(
      gaps.body.items.length === 0,
      "no free slot in the next 48 hours at this time of day",
    );
    const page = await as("owner");
    await openDashboard(page);
    await tap(page.getByTestId("slots-open"));
    await expect(page.getByTestId("slots-count")).toBeVisible();
    // The gap set shifts at every :00 and :30, so each try reads the API again and compares it
    // with what the sheet shows at that moment.
    const diff = async (doctor?: string) => {
      const api = await internal<{ items: { doctor_id: string }[] }>(
        "GET",
        "/internal/admin/ops/gaps?hours=48",
        owner,
      );
      const want = doctor
        ? api.body.items.filter((g) => g.doctor_id === doctor).length
        : api.body.items.length;
      const count = await page
        .getByTestId("slots-count")
        .getAttribute("data-count");
      const rows = await page.getByTestId("slots-list").locator("li").count();
      return { count: Number(count) - want, rows: rows - want };
    };
    await expect.poll(() => diff()).toEqual({ count: 0, rows: 0 });
    const first = gaps.body.items[0]!.doctor_id;
    await page.getByLabel("Doctor").selectOption(first);
    await expect.poll(() => diff(first)).toEqual({ count: 0, rows: 0 });
    await page.keyboard.press("Escape");
  });
});

test.describe("actions are visible where the work is", () => {
  test("a viewer sees no action on the appointment page or the Today board", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    await expect(page.getByTestId("lineage")).toBeVisible();
    await expect(page.getByTestId("staff-actions")).toHaveCount(0);
    for (const name of [
      "Mark arrived",
      "Mark no-show",
      "Veto and lock",
      "Unlock",
      "Cancel appointment",
      "Reschedule",
    ]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-board")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Veto and lock" }),
    ).toHaveCount(0);
    expect(
      (
        await internal(
          "POST",
          `/internal/admin/appointments/${id}/veto`,
          { email: EMAIL.viewer, role: "viewer" },
          { reason: "viewer tries" },
        )
      ).status,
    ).toBe(403);
  });

  test("an admin sees Reschedule and Cancel, and no Veto while the patient has changed nothing", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    const actions = page.getByTestId("staff-actions");
    await expect(actions).toBeVisible();
    for (const name of ["Reschedule", "Cancel appointment"]) {
      await expect(actions.getByRole("button", { name })).toBeVisible();
    }
    // Nothing the patient did is waiting to be undone, so there is no Veto to offer.
    await expect(
      actions.getByRole("button", { name: "Veto and lock" }),
    ).toHaveCount(0);
  });
});
