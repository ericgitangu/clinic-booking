// Staff operations against the real API and database: veto and lock,
// invitations and who may manage whom, the audit trail, and the analytic views. Every figure
// is compared with the API's own answer; nothing here is a hard-coded number.
import AxeBuilder from "@axe-core/playwright";
import {
  humanDate,
  addDays,
  lastDays,
  localDate,
} from "../src/lib/clinic-time";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { expect, signIn, tap, test } from "./support/fixtures";

const owner = { email: OWNER, role: "owner" };
const admin = { email: EMAIL.admin, role: "admin" };

interface Appt {
  id: string;
  doctor_id: string;
  starts_at: string;
  status: string;
}

test.describe("veto and lock", () => {
  test("an admin undoes a patient's move and locks it; the patient is then refused; unlock frees it", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const original = await publicApi<Appt>("GET", `/appointments/${id}`);
    // The patient moves it to another free time the next day.
    const day = addDays(original.body.starts_at.slice(0, 10), 1);
    const avail = await publicApi<{ slots: { starts_at: string }[] }>(
      "GET",
      `/doctors/${original.body.doctor_id}/availability?date=${day}`,
    );
    const target = avail.body.slots[1];
    test.skip(!target, "no free time the next day to move to");
    // Before the patient has changed anything there is nothing to veto, so the button is not there.
    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await expect(page.getByTestId("staff-actions")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Veto and lock" }),
    ).toHaveCount(0);
    const moved = await publicApi("PATCH", `/appointments/${id}/reschedule`, {
      starts_at: target!.starts_at,
    });
    expect(moved.status).toBe(200);

    await page.goto(`/dashboard/appointments/${id}`);
    await tap(page.getByRole("button", { name: "Veto and lock" }));
    const dialog = page.getByRole("dialog", {
      name: "Undo the patient's last change?",
    });
    const confirm = dialog.getByRole("button", { name: "Veto and lock" });
    await expect(confirm).toBeDisabled(); // a reason is required
    await dialog.getByLabel("Reason").fill("clinic needs this time kept");
    await confirm.click();
    await expect(
      page.getByText("Change undone and the appointment locked."),
    ).toBeVisible();
    await expect(page.getByTestId("locked-note")).toBeVisible();

    const after = await publicApi<Appt>("GET", `/appointments/${id}`);
    expect(Date.parse(after.body.starts_at)).toBe(
      Date.parse(original.body.starts_at),
    );
    // The patient cannot change a locked appointment.
    const refused = await publicApi<{ code: string }>(
      "PATCH",
      `/appointments/${id}/cancel`,
      { reason: "patient tries again" },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("APPOINTMENT_LOCKED");

    await tap(page.getByRole("button", { name: "Unlock" }));
    const unlock = page.getByRole("dialog", {
      name: "Unlock this appointment?",
    });
    await unlock.getByLabel("Reason").fill("sorted out with the patient");
    await unlock.getByRole("button", { name: "Unlock appointment" }).click();
    await expect(page.getByText("Appointment unlocked.")).toBeVisible();
    await expect(page.getByTestId("locked-note")).toHaveCount(0);

    const audit = await internal<{
      items: { action: string; reason: string }[];
    }>("GET", `/internal/admin/audit?appointment_id=${id}`, owner);
    const actions = audit.body.items.map((a) => a.action);
    expect(actions).toContain("veto");
    expect(actions).toContain("unlock");
  });

  test("a viewer has no veto or unlock, and the API refuses one", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    await expect(page.getByTestId("lineage")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Veto and lock|Unlock/ }),
    ).toHaveCount(0);
    const res = await internal(
      "POST",
      `/internal/admin/appointments/${id}/veto`,
      { email: EMAIL.viewer, role: "viewer" },
      { reason: "viewer tries" },
    );
    expect(res.status).toBe(403);
  });
});

test.describe("invitations", () => {
  test("an owner invites a viewer, the invitee accepts with the right account, and a wrong account is refused", async ({
    as,
    browser,
  }) => {
    const invitee = `e2e-invitee-${Date.now()}@clinic.example`;
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/access");
    await page.getByLabel("Email to invite").fill(invitee);
    await tap(page.getByRole("button", { name: "Send invitation" }));
    await expect(
      page.getByText(`Invitation made for ${invitee}.`),
    ).toBeVisible();
    const link = await page.getByLabel("Invitation link").inputValue();
    expect(link).toMatch(/\/invite\/[A-Za-z0-9_-]{8,}$/);
    const path = new URL(link).pathname;
    await expect(
      page.getByTestId("invite-list").locator("li", { hasText: invitee }),
    ).toContainText("Waiting");

    // Someone else's account cannot use it; the message is the same whatever the reason.
    const stranger = await browser.newContext();
    await signIn(stranger, EMAIL.stranger);
    const sp = await stranger.newPage();
    await sp.goto(path);
    await sp.getByRole("button", { name: "Accept invitation" }).click();
    await expect(sp.locator("main p[role=alert]")).toHaveText(
      "That invitation is not valid for this account.",
    );
    await stranger.close();

    // The invitee can.
    const ctx = await browser.newContext();
    await signIn(ctx, invitee);
    const ip = await ctx.newPage();
    await ip.goto(path);
    await expect(ip.getByText(invitee)).toBeVisible();
    await ip.getByRole("button", { name: "Accept invitation" }).click();
    await expect(ip).toHaveURL(/\/dashboard$/);
    await expect(ip.getByTestId("staff-role")).toHaveText("Viewer");
    // Used once: the same link no longer works.
    await ip.goto(path);
    await ip.getByRole("button", { name: "Accept invitation" }).click();
    await expect(ip.locator("main p[role=alert]")).toHaveText(
      "That invitation is not valid for this account.",
    );
    await ctx.close();
  });

  test("an owner can revoke an open invitation", async ({ as }) => {
    const invitee = `e2e-revoked-${Date.now()}@clinic.example`;
    const page = await as("owner");
    await page.goto("/access");
    await page.getByLabel("Email to invite").fill(invitee);
    await tap(page.getByRole("button", { name: "Send invitation" }));
    await expect(
      page.getByText(`Invitation made for ${invitee}.`),
    ).toBeVisible();
    await tap(
      page.getByRole("button", {
        name: `Revoke the invitation for ${invitee}`,
      }),
    );
    // Like every action it asks first; this one takes no reason from the API.
    const ask = page.getByRole("dialog", { name: "Revoke this invitation?" });
    await expect(ask.getByLabel("Reason")).toHaveCount(0);
    await ask.getByRole("button", { name: "Revoke invitation" }).click();
    await expect(page.getByText("Invitation revoked.")).toBeVisible();
    await expect(
      page.getByTestId("invite-list").locator("li", { hasText: invitee }),
    ).toContainText("Revoked");
  });

  test("an admin can invite and revoke viewers but not touch the owner or other admins", async ({
    as,
  }) => {
    const page = await as("admin");
    await page.setViewportSize({ width: 1280, height: 900 });
    const res = await page.goto("/access");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Add someone" })).toHaveCount(
      0,
    );
    await expect(page.getByLabel("Email to invite")).toBeVisible();
    const table = page.getByTestId("access-table");
    await expect(
      table.getByRole("button", { name: `Revoke access of ${EMAIL.viewer}` }),
    ).toBeVisible();
    await expect(
      table.getByRole("button", { name: `Revoke access of ${EMAIL.admin}` }),
    ).toHaveCount(0);
    await expect(
      table.getByRole("button", { name: `Revoke access of ${OWNER}` }),
    ).toHaveCount(0);
    await expect(
      table.getByRole("button", { name: /Change role/ }),
    ).toHaveCount(0);
    // The API says the same: an admin cannot revoke an admin.
    const api = await internal<{ code: string }>(
      "DELETE",
      `/internal/admin/access/${encodeURIComponent(EMAIL.admin)}`,
      admin,
    );
    expect([403, 409]).toContain(api.status);
  });

  test("a viewer cannot open the access or audit pages", async ({ as }) => {
    const page = await as("viewer");
    expect((await page.goto("/access"))?.status()).toBe(403);
    expect((await page.goto("/audit"))?.status()).toBe(403);
  });
});

test.describe("audit trail", () => {
  test("lists what staff did, with the reason and no patient names", async ({
    as,
  }) => {
    const id = await bookOneStraightThroughTheApi();
    const done = await internal(
      "PATCH",
      `/internal/admin/appointments/${id}/cancel`,
      owner,
      { reason: "audit page check" },
    );
    expect(done.status).toBe(200);
    const page = await as("admin");
    await page.goto("/audit");
    const list = page.getByTestId("audit-list");
    await expect(list).toBeVisible();
    await expect(
      list.getByText("Reason: audit page check").first(),
    ).toBeVisible();
    await expect(list.getByText("Cancelled").first()).toBeVisible();
    expect(await list.innerText()).not.toContain("E2E Cache Patient");
  });
});

test.describe("why visits were cancelled, and when the clinic is busy", () => {
  test("the reasons list and the peak-hours table match the API", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard?days=30");
    const r = lastDays(new Date(), 30);
    const reasons = await internal<{
      total: number;
      items: { category: string; count: number }[];
    }>(
      "GET",
      `/internal/admin/ops/cancellation-reasons?from=${r.from}&to=${r.to}`,
      owner,
    );
    const heat = await internal<{ cells: { count: number }[]; max: number }>(
      "GET",
      `/internal/admin/ops/heatmap?from=${r.from}&to=${r.to}`,
      owner,
    );
    const shown = reasons.body.items.filter((i) => i.count > 0);
    if (shown.length === 0) {
      await expect(page.getByTestId("reasons-empty")).toBeVisible();
    } else {
      await expect(page.getByTestId("reasons-list").locator("li")).toHaveCount(
        shown.length,
      );
      for (const i of shown) {
        await expect(page.getByTestId("reasons-list")).toContainText(
          `${i.count} (`,
        );
      }
    }
    const total = heat.body.cells.reduce((n, c) => n + c.count, 0);
    if (total === 0) {
      await expect(page.getByTestId("heatmap-empty")).toBeVisible();
    } else {
      const cells = await page
        .getByTestId("heatmap")
        .locator("tbody td")
        .allInnerTexts();
      expect(cells.reduce((n, t) => n + Number(t.trim() || 0), 0)).toBe(total);
    }
  });

  test("the peak-hours doctor choice narrows it to that doctor, as the API counts", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.goto("/dashboard?days=30");
    const docs = await publicApi<{
      items: { id: string; full_name: string }[];
    }>("GET", "/doctors");
    const d = docs.body.items[0]!;
    const r = lastDays(new Date(), 30);
    const heat = await internal<{ cells: { count: number }[] }>(
      "GET",
      `/internal/admin/ops/heatmap?from=${r.from}&to=${r.to}&doctor_id=${d.id}`,
      owner,
    );
    await page.locator("#heatmap-doctor").selectOption(d.id);
    await expect(page).toHaveURL(new RegExp(`doctor=${d.id}`));
    const total = heat.body.cells.reduce((n, c) => n + c.count, 0);
    if (total > 0) {
      await expect
        .poll(async () =>
          (
            await page
              .getByTestId("heatmap")
              .locator("tbody td")
              .allInnerTexts()
          ).reduce((n, t) => n + Number(t.trim() || 0), 0),
        )
        .toBe(total);
    } else {
      await expect(page.getByTestId("heatmap-empty")).toBeVisible();
    }
  });
});

test.describe("marking attendance from the appointment page", () => {
  test("an admin marks arrived, then changes it to no-show with a reason, and sees no Veto on the board row", async ({
    as,
  }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(id, 2);
    const page = await as("admin");
    await page.goto(`/dashboard/appointments/${id}`);
    await tap(page.getByRole("button", { name: "Mark arrived" }));
    {
      const ask = page.getByRole("dialog", { name: "Mark as arrived?" });
      await ask.getByLabel("Reason").fill("patient is at the desk");
      await ask.getByRole("button", { name: "Mark arrived" }).click();
    }
    await expect(page.getByText("Marked arrived.")).toBeVisible();
    await expect(page.getByText(/^\s*Arrived\s*$/)).toBeVisible();
    await tap(page.getByRole("button", { name: "Change to no-show" }));
    const dialog = page.getByRole("dialog", { name: "Change to no-show?" });
    await dialog.getByLabel("Reason").fill("left before being seen");
    await dialog.getByRole("button", { name: "Change to no-show" }).click();
    await expect(page.getByText("Marked no-show.")).toBeVisible();
    await expect(page.getByText(/^\s*No-show\s*$/)).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard");
    const row = page.getByTestId("today-visit").filter({
      has: page.locator(`a[href$="/dashboard/appointments/${id}"]`),
    });
    // The board does not offer Veto: only the appointment page knows a patient change is waiting.
    await expect(
      row.getByRole("button", { name: "Veto and lock" }),
    ).toHaveCount(0);
    // Marked no-show, so the one change on offer is back to arrived.
    await expect(
      row.getByRole("button", { name: "Change to arrived" }),
    ).toBeVisible();
  });

  test("a viewer on the same appointment is offered no mark", async ({
    as,
  }) => {
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const id = await bookOneStraightThroughTheApi();
    moveToPastHalfHour(id, 3);
    const page = await as("viewer");
    await page.goto(`/dashboard/appointments/${id}`);
    await expect(page.getByTestId("lineage")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Mark arrived|Mark no-show/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("staff-actions")).toHaveCount(0);
  });
});

test("the print view heads the page with a spoken Nairobi date", async ({
  as,
}) => {
  const page = await as("owner");
  await page.goto("/dashboard/print");
  await expect(
    page.getByRole("heading", {
      name: `Schedule for ${humanDate(localDate(new Date()))}`,
    }),
  ).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme with data in the analytic views`, () => {
    test.use({ colorScheme: scheme });

    test("the reasons list and the peak-hours table, with real figures, have no serious axe findings", async ({
      as,
    }) => {
      // A visit in the last few hours, cancelled with a reason that groups under transport, so both
      // views have something to draw: the heat map counts booked visits, the reasons list counts
      // cancelled ones.
      const booked = await bookOneStraightThroughTheApi();
      moveToPastHalfHour(booked, scheme === "light" ? 6 : 7);
      const cancelled = await bookOneStraightThroughTheApi();
      const res = await internal(
        "PATCH",
        `/internal/admin/appointments/${cancelled}/cancel`,
        owner,
        { reason: "no transport to get there" },
      );
      expect(res.status).toBe(200);
      moveToPastHalfHour(cancelled, 0, true);

      const page = await as("owner");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/dashboard?days=7");
      await expect(page.getByTestId("heatmap")).toBeVisible();
      await expect(page.getByTestId("reasons-list")).toBeVisible();
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
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
      const serious = violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(
        serious.map(
          (v) =>
            `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
        ),
      ).toEqual([]);
    });
  });
}

test("the access, audit and invitation pages have no serious axe findings", async ({
  as,
}) => {
  const page = await as("owner");
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ["/access", "/audit"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForFunction(() =>
      document.getAnimations().every((a) => a.playState !== "running"),
    );
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
            `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
        ),
    ).toEqual([]);
  }
});
