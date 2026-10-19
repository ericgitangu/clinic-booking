// The dashboard against the real API and database. Expected numbers are read from the real API
// with a real signed assertion and compared with what the page shows; histories are the ones the
// seeding really produced by booking, rescheduling and cancelling.
import { addDays, lastDays, localDate } from "../src/lib/clinic-time";
import { humanDate } from "../src/lib/clinic-time";
import { formatLead, shareDelta } from "../src/lib/kpi-delta";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { expect, seeded, tap, test } from "./support/fixtures";

interface Metrics {
  totals: {
    upcoming_active: number;
    cancelled: number;
    booked: number;
    rescheduled: number;
  };
  per_doctor: { name: string; doctor_id: string }[];
}
interface Lineage {
  events: { event_type: string }[];
}

const owner = { email: OWNER, role: "owner" };

test.describe("owner dashboard", () => {
  test("shows the numbers the API reports", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=7");
    const week = lastDays(new Date(), 7);
    const m = await internal<Metrics>(
      "GET",
      `/internal/admin/metrics?from=${week.from}&to=${week.to}&bucket=day`,
      owner,
    );
    expect(m.status).toBe(200);

    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("staff-role")).toHaveText("Owner");
    await expect(page.getByTestId("kpi-upcoming-booked")).toHaveText(
      String(m.body.totals.upcoming_active),
    );
    const ops = await internal<{ counts: { cancelled: number } }>(
      "GET",
      `/internal/admin/ops/kpis?from=${week.from}&to=${week.to}`,
      owner,
    );
    await expect(page.getByTestId("kpi-cancelled-visits")).toHaveText(
      String(ops.body.counts.cancelled),
    );
    await expect(page.getByTestId("kpi-utilisation")).toHaveText(
      /^(\d+%|None)$/,
    );
    // The seeding booked at least ten and cancelled one, so these are not zeros.
    expect(m.body.totals.upcoming_active).toBeGreaterThanOrEqual(10);
    expect(m.body.totals.cancelled).toBeGreaterThanOrEqual(1);
    for (const d of m.body.per_doctor) {
      await expect(page.getByText(d.name).first()).toBeVisible();
    }
    await expect(
      page.getByRole("img", { name: /Line chart of bookings/ }),
    ).toBeVisible();
  });

  test("the Today totals are the API's own", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const board = await internal<{
      totals: {
        booked: number;
        arrived: number;
        no_show: number;
        cancelled: number;
      };
    }>("GET", `/internal/admin/ops/today?date=${localDate(new Date())}`, owner);
    expect(board.status).toBe(200);
    const t = board.body.totals;
    await expect(page.getByTestId("today-totals")).toHaveText(
      `${t.booked} booked, ${t.arrived} arrived, ${t.no_show} no-show, ${t.cancelled} cancelled.`,
    );
  });

  test("the range control changes the range in the address", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    await expect(async () => {
      await page
        .getByRole("radiogroup", { name: "Range" })
        .getByRole("radio", { name: "30 days" })
        .click();
      await expect(page).toHaveURL(/days=30/, { timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await expect(
      page.getByRole("radio", { name: "30 days", exact: true }),
    ).toBeChecked();
  });

  test("the status filter narrows the list to cancelled appointments", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    // A click before the page has hydrated does nothing, so click until the address changes.
    await expect(async () => {
      await page
        .getByRole("radiogroup", { name: "Show" })
        .getByRole("radio", { name: "Cancelled" })
        .click();
      await expect(page).toHaveURL(/status=cancelled/, { timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    const rows = page.getByTestId("appointments-table").getByRole("row");
    await expect(rows.nth(1)).toContainText("Cancelled");
    for (const text of await page
      .getByTestId("appointments-table")
      .locator("tbody tr")
      .allInnerTexts()) {
      expect(text).toContain("Cancelled");
    }
  });

  test("the filters work from the keyboard with arrow keys", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=14&status=all");
    const group = page.getByRole("radiogroup", { name: "Show" });
    await group.getByRole("radio", { name: "All" }).focus();
    // Only the chosen option is in the tab order; the arrow moves the choice and the focus.
    await expect(group.getByRole("radio", { name: "Booked" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/status=booked/);
    await expect(group.getByRole("radio", { name: "Booked" })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/status=cancelled/);
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(/status=booked/);
    // Focus is still on the group after the page data has reloaded.
    await expect(group.getByRole("radio", { name: "Booked" })).toBeFocused();
  });

  test("each KPI card shows the API's value and its change against the period before", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=7");
    const r = lastDays(new Date(), 7);
    const res = await internal<
      Record<
        string,
        { value: number | null; previous: number | null } | unknown
      >
    >("GET", `/internal/admin/ops/kpis?from=${r.from}&to=${r.to}`, owner);
    expect(res.status).toBe(200);
    const v = (k: string) =>
      res.body[k] as { value: number | null; previous: number | null };
    const pct = (x: number | null) =>
      x === null ? "None" : `${Math.round(x * 100)}%`;
    for (const [id, key, better, none] of [
      ["fill-rate", "fill_rate", "up", "No slots offered before"],
      ["utilisation", "utilisation", "up", "No slots offered before"],
      ["cancellation-rate", "cancellation_rate", "down", "No bookings before"],
      ["no-show-rate", "no_show_rate", "down", "No marked visits before"],
    ] as const) {
      await expect(page.getByTestId(`kpi-${id}`)).toHaveText(pct(v(key).value));
      const delta = shareDelta(v(key).value, v(key).previous, better, none);
      if (delta) {
        await expect(page.getByTestId(`kpi-${id}-delta`)).toHaveText(
          delta.text,
        );
      }
    }
    const lead = v("median_lead_minutes");
    await expect(page.getByTestId("kpi-median-lead-time")).toHaveText(
      lead.value === null ? "None" : formatLead(lead.value / 60),
    );
    await expect(page.getByTestId("kpi-reschedules")).toHaveText(
      String(v("reschedules").value ?? 0),
    );
    await expect(
      page.getByText("Changes compare with the 7 days before."),
    ).toBeVisible();
    // A snapshot of now has nothing to compare with, so it shows no change.
    await expect(page.getByTestId("kpi-upcoming-booked-delta")).toHaveCount(0);
  });

  test("the activity chart is straight-lined, starts at zero and has a table", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard?days=14");
    const chart = page.getByRole("img", { name: /Line chart of bookings/ });
    await expect(chart).toBeVisible();
    // Straight segments only: a spline would draw "C" curve commands and overshoot the data.
    await expect(chart.locator("path.recharts-line-curve")).toHaveCount(3);
    const paths = await chart
      .locator("path.recharts-line-curve")
      .evaluateAll((els) => els.map((e) => e.getAttribute("d") ?? ""));
    expect(paths.length).toBe(3);
    for (const d of paths) expect(d).not.toMatch(/C/);
    // The y-axis labels are the SVG texts that are bare numbers (the x labels are dates).
    const labels = chart.locator("svg text");
    await expect(labels.first()).toBeAttached();
    const ticks = (
      await labels.evaluateAll((els) => els.map((e) => e.textContent ?? ""))
    )
      .filter((t) => /^\d+$/.test(t))
      .map(Number);
    expect(ticks.length).toBeGreaterThan(1);
    expect(Math.min(...ticks)).toBe(0);
    await expect(page.getByTestId("activity-summary")).toContainText(
      "Busiest day",
    );
    await page.getByText("Show the numbers as a table").click();
    await expect(
      page.getByRole("table", { name: "Activity per day" }),
    ).toBeVisible();
  });

  test("each doctor has a face, a figure and a meter", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=14");
    const m = await internal<Metrics>(
      "GET",
      `/internal/admin/metrics?from=${lastDays(new Date(), 14).from}&to=${lastDays(new Date(), 14).to}&bucket=day`,
      owner,
    );
    const list = page.getByTestId("utilisation-list");
    for (const d of m.body.per_doctor) {
      const row = list.locator("li", { hasText: d.name });
      await expect(row.locator("img, [role=img]").first()).toBeVisible();
      await expect(
        row.getByRole("meter", { name: `${d.name} utilisation` }),
      ).toBeVisible();
    }
  });

  test("a row opens its appointment, showing the same patient and a status in words", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const first = page
      .getByTestId("appointments-table")
      .locator("tbody tr")
      .first();
    const patient = (await first.locator("td").nth(1).innerText()).split(
      ",",
    )[0]!;
    await expect(first.getByText(/^\s*(Booked|Cancelled)\s*$/)).toBeVisible();
    // Click the doctor cell, not the link: the whole row is the target. The link's overlay sits
    // on top of the cell, so a real mouse click at the cell's centre is what a person does.
    // The live panel above the table can change height while it connects, which moves the row
    // between measuring and clicking, so measure and click again until the page has moved.
    await expect(async () => {
      await first.scrollIntoViewIfNeeded();
      const cell = await first.locator("td").nth(2).boundingBox();
      await page.mouse.click(
        cell!.x + cell!.width / 2,
        cell!.y + cell!.height / 2,
      );
      await expect(page).toHaveURL(
        /\/dashboard\/appointments\/[0-9a-f-]{36}$/,
        { timeout: 2500 },
      );
    }).toPass({ timeout: 15_000 });
    await expect(page.getByTestId("appointment-patient")).toHaveText(
      patient.trim(),
    );
  });

  test("the Today board shows each doctor's day exactly as the API reports it", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const board = await internal<{
      doctors: {
        doctor_id: string;
        name: string;
        next_gap: { starts_at: string } | null;
        running_behind: { behind: boolean; minutes: number };
        appointments: { id: string; status: string }[];
      }[];
    }>("GET", `/internal/admin/ops/today?date=${localDate(new Date())}`, owner);
    expect(board.body.doctors.length).toBeGreaterThan(0);
    for (const d of board.body.doctors) {
      const card = page.getByTestId(`today-${d.doctor_id}`);
      await expect(card.getByRole("heading", { name: d.name })).toBeVisible();
      await expect(card.getByTestId("today-summary")).toContainText(
        `${d.appointments.filter((a) => a.status === "booked").length} booked`,
      );
      await expect(card.getByTestId("today-visit")).toHaveCount(
        d.appointments.length,
      );
      await expect(card.getByTestId("today-summary")).toContainText(
        d.next_gap ? "Next free" : "Nothing free",
      );
      await expect(card.getByTestId("running-behind")).toHaveCount(
        d.running_behind.behind ? 1 : 0,
      );
    }
  });

  test("gaps to fill lists the API's free slots for the next 48 hours, or says there is none", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const gaps = await internal<{ items: unknown[] }>(
      "GET",
      "/internal/admin/ops/gaps?hours=48",
      owner,
    );
    expect(gaps.status).toBe(200);
    if (gaps.body.items.length > 0) {
      await expect(page.getByTestId("gaps-list")).toBeVisible();
      await expect(
        page.getByTestId("gap").first().getByRole("button", {
          name: "Book on behalf",
        }),
      ).toBeVisible();
    } else {
      await expect(page.getByTestId("gaps-empty")).toBeVisible();
    }
  });

  test("the day sheet is the API's own CSV", async ({ as }) => {
    const page = await as("owner");
    const own = await publicApi<{ starts_at: string }>(
      "GET",
      `/appointments/${seeded().rescheduled}`,
    );
    const date = localDate(new Date(own.body.starts_at));
    const api = await internal<string>(
      "GET",
      `/internal/admin/ops/day-sheet.csv?date=${date}`,
      owner,
    );
    expect(api.status).toBe(200);
    const res = await page.request.get(`/dashboard/day-sheet?date=${date}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(
      `day-sheet-${date}.csv`,
    );
    expect(await res.text()).toBe(api.body);
    expect(api.body.trim().split(/\r?\n/).length).toBeGreaterThan(1);
  });

  test("the print view shows a table per doctor who has visits today", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard/print");
    await expect(
      page.getByRole("heading", {
        name: `Schedule for ${humanDate(localDate(new Date()))}`,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Print" })).toBeVisible();
  });

  test("a viewer gets no actions, no export, and a 403 from the export routes", async ({
    as,
  }) => {
    const page = await as("viewer");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-board")).toBeVisible();
    await expect(page.getByRole("link", { name: /Day sheet/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Print" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
    expect((await page.request.get("/dashboard/day-sheet")).status()).toBe(403);
    expect((await page.goto("/dashboard/print"))?.status()).toBe(403);
  });

  test("an admin sees the export and, on a visit still to come today, move and cancel", async ({
    as,
  }) => {
    const page = await as("admin");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: /Day sheet/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Print" })).toBeVisible();
    // Whether today still has a booked visit ahead depends on the clock, so ask the API first.
    const today = localDate(new Date());
    const list = await internal<{
      items: { starts_at: string; status: string }[];
    }>(
      "GET",
      `/internal/admin/appointments?status=booked&from=${today}&to=${addDays(today, 1)}&limit=100`,
      owner,
    );
    const ahead = list.body.items.filter(
      (a) => Date.parse(a.starts_at) > Date.now() + 60_000,
    );
    const board = page.getByTestId("today-board");
    if (ahead.length > 0) {
      await expect(
        board.getByRole("button", { name: "Cancel appointment" }).first(),
      ).toBeVisible();
      await expect(
        board.getByRole("button", { name: "Reschedule" }).first(),
      ).toBeVisible();
    } else {
      await expect(
        board.getByRole("button", { name: "Cancel appointment" }),
      ).toHaveCount(0);
    }
  });

  test("the 404 page keeps the signed-in header", async ({ as }) => {
    const page = await as("owner");
    const res = await page.goto("/no-such-page-here");
    expect(res?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "We could not find that page" }),
    ).toBeVisible();
    await expect(page.getByTestId("staff-role")).toHaveText("Owner");
    await expect(
      page.getByRole("button", { name: /Account menu for/ }),
    ).toBeVisible();
  });

  test("single-key shortcuts can be turned off, and the choice sticks", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-board")).toBeVisible();
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const toggle = help.getByRole("checkbox", { name: /Single-key shortcuts/ });
    await expect(toggle).toBeChecked();
    // Reachable by keyboard, and switched with the space bar.
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Escape");

    // Letters now do nothing; the modifier chord and the header button still work.
    await page.keyboard.press("j");
    await expect(page.locator("a[data-row-link]:focus")).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(help).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("today-board")).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.locator("a[data-row-link]:focus")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(
      page.getByRole("combobox", { name: "Search commands and appointments" }),
    ).toBeFocused();
    // Turn them back on from the palette, which is reachable without any single key.
    await page.keyboard.type("single-key");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Search commands and appointments" }),
    ).toHaveCount(0);
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
  });

  test("a viewer's DOM has initials, a masked phone and no reason text, from the API's own projection", async ({
    as,
  }) => {
    const page = await as("viewer");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard?status=cancelled");
    const table = page.getByTestId("appointments-table");
    await expect(table).toBeVisible();
    const viewerRows = await internal<{
      view: string;
      items: {
        id: string;
        patient_name: string;
        patient_phone: string | null;
        patient_email: string | null;
        cancellation_reason: string | null;
      }[];
    }>("GET", "/internal/admin/appointments?status=cancelled&limit=10", {
      email: EMAIL.viewer,
      role: "viewer",
    });
    const fullRows = await internal<{
      items: {
        id: string;
        patient_name: string;
        cancellation_reason: string | null;
      }[];
    }>("GET", "/internal/admin/appointments?status=cancelled&limit=10", owner);
    expect(viewerRows.body.view).toBe("minimised");
    expect(fullRows.body.items.length).toBeGreaterThan(0);
    const html = await page.content();
    for (const a of fullRows.body.items) {
      expect(html).not.toContain(a.patient_name);
      if (a.cancellation_reason)
        expect(html).not.toContain(a.cancellation_reason);
    }
    for (const a of viewerRows.body.items) {
      expect(a.patient_email).toBeNull();
      expect(a.cancellation_reason).toBeNull();
      expect(html).toContain(a.patient_name); // the API's initials, shown as sent
    }
    // The appointment page does not leak the reason either (the public read carries it).
    const cancelled = fullRows.body.items.find((a) => a.cancellation_reason);
    if (cancelled) {
      await page.goto(`/dashboard/appointments/${cancelled.id}`);
      await expect(page.getByTestId("lineage")).toBeVisible();
      expect(await page.content()).not.toContain(
        cancelled.cancellation_reason!,
      );
    }
  });

  test("every gap on the list is a slot a patient could book, so the list equals bookable truth", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const gaps = await internal<{
      items: { doctor_id: string; starts_at: string }[];
    }>("GET", "/internal/admin/ops/gaps?hours=48", owner);
    const seen = new Map<string, Set<string>>();
    // Staff may book inside the next hour; patients may not, so compare from two hours out.
    const comparable = gaps.body.items.filter(
      (g) => Date.parse(g.starts_at) > Date.now() + 2 * 3_600_000,
    );
    for (const g of comparable.slice(0, 12)) {
      const day = localDate(new Date(g.starts_at));
      const key = `${g.doctor_id}|${day}`;
      if (!seen.has(key)) {
        const a = await publicApi<{ slots: { starts_at: string }[] }>(
          "GET",
          `/doctors/${g.doctor_id}/availability?date=${day}`,
        );
        seen.set(
          key,
          new Set(a.body.slots.map((s) => Date.parse(s.starts_at) + "")),
        );
      }
      expect(seen.get(key)!.has(Date.parse(g.starts_at) + "")).toBe(true);
    }
  });

  test("keyboard: ? opens the shortcut list, g then d goes home, j and k walk the rows", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/access");
    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    await expect(help).toContainText("Go to the dashboard");
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);

    const rows = page.locator("a[data-row-link]:visible");
    await page.keyboard.press("j");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dashboard\/appointments\//);
  });

  test("keyboard: search opens with /, never eats typed letters, runs a command", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    await page.keyboard.press("/");
    const box = page.getByRole("combobox", {
      name: "Search commands and appointments",
    });
    await expect(box).toBeFocused();
    // Letters that are shortcuts elsewhere are just letters here.
    await box.pressSequentially("gjk?");
    await expect(box).toHaveValue("gjk?");
    await expect(page).toHaveURL(/\/dashboard$/);
    // "Show cancelled" is the command; a bare "cancelled" would also match any cancelled visit
    // listed on the page, which depends on what the other specs left behind.
    await box.fill("show cancelled");
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/status=cancelled/);
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("the utilisation bars do not animate", async ({ as }) => {
      const page = await as("owner");
      await page.goto("/dashboard");
      const name = await page
        .locator(".bar-grow")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName);
      expect(name).toBe("none");
    });
  });

  test("the header shows the avatar, the role and the brand, not the raw email", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    const header = page.getByRole("banner");
    await expect(header.getByText("Idyllic Clinic Admin")).toBeVisible();
    await expect(header.getByTestId("staff-role")).toHaveText("Owner");
    await expect(header.getByText(OWNER)).toHaveCount(0);
    await expect(page.getByRole("contentinfo")).toContainText(
      "Idyllic Clinic Admin",
    );
  });
});

test.describe("desk actions", () => {
  test.describe.configure({ mode: "serial" });

  test("an admin marks a visit arrived, then changes it to no-show with a reason; the API agrees", async ({
    as,
  }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(id, 0);
    const page = await as("admin");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const row = page.getByTestId("today-visit").filter({
      has: page.locator(`a[href$="/dashboard/appointments/${id}"]`),
    });
    await expect(row.getByText(/^\s*Booked\s*$/)).toBeVisible();
    await tap(row.getByRole("button", { name: "Mark arrived" }));
    await expect(page.getByText("Marked as arrived.")).toBeVisible();
    await expect(row.getByText(/^\s*Arrived\s*$/)).toBeVisible();
    const after = await internal<{
      items: { id: string; attendance: string | null }[];
    }>(
      "GET",
      `/internal/admin/appointments?status=booked&from=${localDate(new Date())}&to=${addDays(localDate(new Date()), 1)}&limit=100`,
      owner,
    );
    expect(after.body.items.find((a) => a.id === id)?.attendance).toBe(
      "arrived",
    );

    // Changing a mark needs a reason.
    await tap(row.getByRole("button", { name: "Change to no-show" }));
    const dialog = page.getByRole("dialog", { name: "Change to no-show?" });
    const confirm = dialog.getByRole("button", { name: "Change to no-show" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason").fill("patient left before being seen");
    await confirm.click();
    await expect(page.getByText("Marked as no-show.")).toBeVisible();
    await expect(row.getByText(/^\s*No-show\s*$/)).toBeVisible();
  });

  test("the API refuses a mark outside the window, and the board offers none", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi(); // weeks ahead
    const res = await internal<{ code: string }>(
      "POST",
      `/internal/admin/appointments/${id}/arrived`,
      owner,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ATTENDANCE_WINDOW_CLOSED");
    const viewer = await internal(
      "POST",
      `/internal/admin/appointments/${id}/arrived`,
      { email: EMAIL.viewer, role: "viewer" },
    );
    expect(viewer.status).toBe(403);
    const page = await as("admin");
    await page.goto("/dashboard");
    await expect(page.getByTestId("today-board")).toBeVisible();
    await expect(
      page
        .getByTestId("today-board")
        .locator(`a[href$="/dashboard/appointments/${id}"]`),
    ).toHaveCount(0);
  });

  test("a viewer sees the visit but no way to mark it", async ({ as }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(id, 1);
    const page = await as("viewer");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await expect(
      page.locator(`a[href$="/dashboard/appointments/${id}"]`),
    ).toBeVisible();
    for (const name of ["Mark arrived", "Mark no-show", "Book on behalf"]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
  });

  test("an admin books a patient into a free gap; the booking is real and audited", async ({
    as,
  }) => {
    const gaps = await internal<{ items: unknown[] }>(
      "GET",
      "/internal/admin/ops/gaps?hours=48",
      owner,
    );
    test.skip(
      gaps.body.items.length === 0,
      "no free slot in the next 48 hours at this time of day",
    );
    const name = `E2E Walk-in ${Date.now()}`;
    const page = await as("admin");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    await tap(
      page.getByTestId("gap").first().getByRole("button", {
        name: "Book on behalf",
      }),
    );
    const dialog = page.getByRole("dialog", { name: "Book for a patient" });
    const submit = dialog.getByRole("button", { name: "Book appointment" });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("Patient name").fill(name);
    await dialog.getByLabel("Reason").fill("patient phoned the front desk");
    await submit.click();
    await expect(page.getByText(`Booked for ${name}.`)).toBeVisible();

    const today = localDate(new Date());
    const list = await internal<{ items: { patient_name: string }[] }>(
      "GET",
      `/internal/admin/appointments?status=booked&from=${today}&to=${addDays(today, 4)}&limit=100`,
      owner,
    );
    expect(list.body.items.some((a) => a.patient_name === name)).toBe(true);
    const audit = await internal<{
      items: { action: string; reason: string }[];
    }>("GET", "/internal/admin/audit?limit=20", owner);
    expect(
      audit.body.items.some(
        (a) =>
          a.action === "book" && a.reason === "patient phoned the front desk",
      ),
    ).toBe(true);
  });

  test("a viewer's list shows initials, not full names", async ({ as }) => {
    const page = await as("viewer");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const table = page.getByTestId("appointments-table");
    await expect(table).toBeVisible();
    expect(await table.innerText()).not.toContain("E2E Patient");
  });
});

test.describe("an appointment's history", () => {
  test("a rescheduled appointment reads booked, then rescheduled", async ({
    as,
  }) => {
    const id = seeded().rescheduled;
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    const api = await internal<Lineage>(
      "GET",
      `/internal/admin/appointments/${id}/lineage`,
      owner,
    );
    expect(api.body.events.map((e) => e.event_type)).toEqual([
      "booked",
      "rescheduled",
    ]);
    const steps = page.getByTestId("lineage").locator("> li");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText("Booked");
    await expect(steps.nth(1)).toContainText("Rescheduled");
  });

  test("a cancelled appointment reads booked, then cancelled, with its reason", async ({
    as,
  }) => {
    const id = seeded().cancelled;
    const page = await as("owner"); // a viewer is not shown the reason, see the viewer test
    await page.goto(`/dashboard/appointments/${id}`);
    const steps = page.getByTestId("lineage").locator("> li");
    await expect(steps.nth(0)).toContainText("Booked");
    await expect(steps.nth(1)).toContainText("Cancelled");
    await expect(
      page.getByText("Reason: patient called to cancel"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
  });

  test("an unknown appointment is a 404", async ({ as }) => {
    const page = await as("viewer");
    const res = await page.goto(
      "/dashboard/appointments/00000000-0000-4000-8000-0000000000ff",
    );
    expect(res?.status()).toBe(404);
  });
});

test.describe("acting for a patient", () => {
  test("a viewer sees the history but no actions", async ({ as }) => {
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${seeded().free[0]}`);
    await expect(page.getByTestId("lineage-booked")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reschedule" })).toHaveCount(
      0,
    );
  });

  test("an admin cancels an appointment and the history records it", async ({
    as,
  }) => {
    const id = seeded().free[1];
    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await tap(page.getByRole("button", { name: "Cancel appointment" }));
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Cancel appointment" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason").fill("patient called to cancel");
    await confirm.click();
    await expect(page.getByText("Appointment cancelled.")).toBeVisible();
    await expect(page.getByTestId("lineage-cancelled")).toBeVisible();

    const real = await publicApi<{
      status: string;
      cancellation_reason: string;
    }>("GET", `/appointments/${id}`);
    expect(real.body.status).toBe("cancelled");
    expect(real.body.cancellation_reason).toContain("patient called to cancel");
    // And once cancelled the actions are gone.
    await expect(
      page.getByRole("button", { name: "Cancel appointment" }),
    ).toHaveCount(0);
  });

  test("an admin moves an appointment to a free time", async ({ as }) => {
    const id = seeded().free[2];
    const before = await publicApi<{ starts_at: string; doctor_id: string }>(
      "GET",
      `/appointments/${id}`,
    );
    // A day with free times: the day after the appointment's own.
    let date = addDays(before.body.starts_at.slice(0, 10), 1);
    let freeTimes = 0;
    for (let i = 0; i < 10 && freeTimes === 0; i++) {
      const avail = await publicApi<{ slots: unknown[] }>(
        "GET",
        `/doctors/${before.body.doctor_id}/availability?date=${date}`,
      );
      freeTimes = avail.body.slots.length;
      if (freeTimes === 0) date = addDays(date, 1);
    }
    expect(freeTimes).toBeGreaterThan(0);

    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await tap(page.getByRole("button", { name: "Reschedule" }));
    await page.getByLabel("Day").fill(date);
    await page.locator("#move-slot").click();
    await page.getByRole("option").first().click();
    const move = page.getByRole("button", { name: "Move appointment" });
    await expect(move).toBeDisabled(); // a reason is required
    await page.getByLabel("Reason").fill("patient asked for a later day");
    await move.click();
    await expect(page.getByText("Appointment rescheduled.")).toBeVisible();

    const after = await publicApi<{ starts_at: string }>(
      "GET",
      `/appointments/${id}`,
    );
    expect(after.body.starts_at).not.toBe(before.body.starts_at);
    expect(after.body.starts_at.slice(0, 10)).toBe(date);
    const lineage = await internal<Lineage>(
      "GET",
      `/internal/admin/appointments/${id}/lineage`,
      owner,
    );
    expect(lineage.body.events.map((e) => e.event_type)).toEqual([
      "booked",
      "rescheduled",
    ]);
  });
});

test.describe("layout", () => {
  test.describe("on a phone", () => {
    test.use({ viewport: { width: 375, height: 800 } });

    test("appointments are cards, not a table, and nothing scrolls sideways", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/dashboard");
      await expect(page.getByTestId("appointments-cards")).toBeVisible();
      await expect(page.getByTestId("appointments-table")).toBeHidden();
      // Wait for the streamed content (board, gaps) before measuring.
      await expect(page.getByTestId("today-board")).toBeVisible();
      const { overflow, offenders } = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return {
          overflow: document.documentElement.scrollWidth - w,
          offenders: [...document.querySelectorAll("body *")]
            .filter(
              (e) =>
                e.getBoundingClientRect().right > w + 1 &&
                getComputedStyle(e).position !== "fixed",
            )
            .slice(0, 8)
            .map(
              (e) =>
                `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).slice(0, 60)} right=${Math.round(e.getBoundingClientRect().right)}`,
            ),
        };
      });
      // The offending elements are in the message, so a failure says where the page is too wide.
      expect(overflow, offenders.join("\n")).toBeLessThanOrEqual(0);
    });

    test("access entries are cards with finger-sized buttons", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/access");
      await expect(page.getByTestId("access-cards")).toBeVisible();
      await expect(page.getByTestId("access-table")).toBeHidden();
      const box = await page
        .getByTestId("access-cards")
        .getByRole("button", { name: `Change role of ${EMAIL.admin}` })
        .boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  });

  test.describe("on a desktop", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("appointments are a table that pages to older ones and back", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.goto("/dashboard");
      await expect(page.getByTestId("appointments-table")).toBeVisible();
      await expect(page.getByTestId("appointments-cards")).toBeHidden();
      await page.getByRole("link", { name: "Older appointments" }).click();
      await expect(page).toHaveURL(/cursor=/);
      await expect(page.getByTestId("appointments-table")).toBeVisible();
      await page.getByRole("link", { name: "Back to latest" }).click();
      await expect(page).not.toHaveURL(/cursor=/);
    });
  });
});
