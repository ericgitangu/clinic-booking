// The live feed against the real stack: the production build of this app, the real API, the real
// Postgres and the real Go gateway (docker compose, profile "realtime"). A booking is made through
// the public API, exactly as a patient's would be, and the dashboard in a real browser must show it.
// Only Google's own sign-in is replaced (support/test-auth.ts).
import type { Page } from "@playwright/test";
import { holdSlot, opened } from "./support/gateway";
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { expect, seeded, signIn, tap, test } from "./support/fixtures";

interface Slot {
  starts_at: string;
}

let counter = 0;

/** A new patient with a recognisable name and a booking in the next weeks. */
async function book(name: string) {
  const { doctorId } = seeded();
  const phone = `+2547${String(Date.now() + counter++).slice(-8)}`;
  const patient = await publicApi<{ id: string }>("POST", "/patients", {
    full_name: name,
    phone,
  });
  expect(patient.status).toBe(201);
  const start = 3 + Math.floor(Math.random() * 40);
  for (let ahead = start; ahead < 85; ahead++) {
    const date = new Date(Date.now() + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const avail = await publicApi<{ slots: Slot[] }>(
      "GET",
      `/doctors/${doctorId}/availability?date=${date}`,
    );
    const slots = avail.body.slots;
    if (slots.length < 2) continue;
    const slot = slots[Math.floor(Math.random() * slots.length)];
    const res = await publicApi<{ id: string }>("POST", "/appointments", {
      doctor_id: doctorId,
      patient_id: patient.body.id,
      starts_at: slot.starts_at,
    });
    if (res.status === 201)
      return { id: res.body.id, name, date, startsAt: slot.starts_at };
  }
  throw new Error("no free slot to book");
}

/** The patient moves their own booking to another free time the same day. */
async function patientReschedules(made: {
  id: string;
  date: string;
  startsAt: string;
}) {
  const { doctorId } = seeded();
  const avail = await publicApi<{ slots: Slot[] }>(
    "GET",
    `/doctors/${doctorId}/availability?date=${made.date}`,
  );
  const to = avail.body.slots.find(
    (s) => Date.parse(s.starts_at) !== Date.parse(made.startsAt),
  );
  if (!to) throw new Error("no second free slot that day");
  const moved = await publicApi(
    "PATCH",
    `/appointments/${made.id}/reschedule`,
    { starts_at: to.starts_at },
  );
  expect(moved.status).toBe(200);
}

const ADMIN = { email: EMAIL.admin, role: "admin" };

async function live(page: import("@playwright/test").Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("live-status")).toHaveAttribute(
    "data-status",
    "live",
  );
}

test.describe("live feed", () => {
  test("the appointments table does not move when events arrive", async ({
    as,
  }) => {
    const page = await as("owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await live(page);
    const feed = page.getByTestId("live-feed");
    const table = page.getByTestId("appointments-table");
    const row = table.locator("tbody tr").first();
    await expect(row).toBeVisible();
    // Rows come and go as the list refreshes, so the fixed points are the panel and the table's
    // own top edge: if either moves, every row under the pointer moves with it.
    const before = {
      feed: await feed.boundingBox(),
      table: await table.boundingBox(),
      row: await row.boundingBox(),
    };
    expect(before.feed && before.table && before.row).toBeTruthy();
    const names = [1, 2, 3].map((n) => `Steady Layout ${n} ${Date.now()}`);
    for (const name of names) {
      await book(name);
      await expect(
        page.getByTestId("live-event").filter({ hasText: name }),
      ).toBeVisible({ timeout: 2000 });
      const feedNow = await feed.boundingBox();
      const tableNow = await table.boundingBox();
      expect(feedNow).toEqual(before.feed);
      expect(tableNow?.y).toBe(before.table!.y);
      expect(tableNow?.x).toBe(before.table!.x);
    }
    // The list refreshes a couple of seconds after the last event; the first row stays where it was.
    await expect(async () => {
      expect((await row.boundingBox())?.y).toBe(before.row!.y);
    }).toPass();
  });

  test("an owner sees a booking appear within 2 seconds, with the patient and a link to it", async ({
    as,
  }) => {
    const page = await as("owner");
    await live(page);
    const name = `Live Booking ${Date.now()}`;
    const made = await book(name);

    const row = page.getByTestId("live-event").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 2000 });
    await expect(row).toHaveAttribute("data-kind", "booked");
    await expect(row.getByRole("link")).toHaveAttribute(
      "href",
      `/dashboard/appointments/${made.id}`,
    );
  });

  test("a cancellation arrives with its reason, and a reschedule with where it came from", async ({
    as,
  }) => {
    const page = await as("owner");
    await live(page);
    const name = `Live Change ${Date.now()}`;
    const made = await book(name);
    await expect(
      page.getByTestId("live-event").filter({ hasText: name }),
    ).toBeVisible({ timeout: 2000 });

    const cancelled = await publicApi(
      "PATCH",
      `/appointments/${made.id}/cancel`,
      { reason: "Family emergency" },
    );
    expect(cancelled.status).toBe(200);
    const row = page
      .getByTestId("live-event")
      .filter({ hasText: "Reason: Family emergency" });
    await expect(row).toBeVisible({ timeout: 2000 });
    await expect(row).toHaveAttribute("data-kind", "cancelled");
    await expect(row).toContainText(name);
  });

  test("a viewer sees the booking without the patient: not on the page, not in the stream", async ({
    as,
  }) => {
    const page = await as("viewer");
    await live(page);
    const name = `Hidden Patient ${Date.now()}`;
    const made = await book(name);

    const rows = page.getByTestId("live-event");
    await expect(rows.first()).toBeVisible({ timeout: 2000 });
    await expect(rows.first()).toHaveAttribute("data-kind", "booked");
    await expect(rows.first().getByRole("link")).toHaveCount(0);
    const html = await page.content();
    expect(html).not.toContain(name);
    expect(html).not.toContain(made.id);

    // The same stream, read directly with the viewer's own session: no personal field at all. The
    // page lets go of its stream first (the local gateway serves one at a time), so the direct
    // read must get 200: a 429 here would mean the test proved nothing.
    const second = `Hidden Again ${Date.now()}`;
    await page.exposeFunction("bookNow", async () => {
      await book(second);
    });
    await page.goto("/live-feed-e2e-no-stream");
    const raw = await page.evaluate(async () => {
      const w = window as unknown as { bookNow: () => Promise<void> };
      let res: Response | null = null;
      const ctl = new AbortController();
      // The gateway frees the slot when it notices the page's stream is gone: allow it a moment.
      for (let i = 0; i < 40; i++) {
        res = await fetch("/live/stream", { signal: ctl.signal });
        if (res.status === 200) break;
        await res.body?.cancel();
        await new Promise((ok) => setTimeout(ok, 250));
      }
      if (!res || res.status !== 200)
        return { status: res?.status ?? 0, text: "" };
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      let booked = false;
      const until = Date.now() + 8000;
      while (Date.now() < until && !text.includes("event: booked")) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((ok) =>
            setTimeout(() => ok({ done: true, value: undefined }), 1000),
          ),
        ]);
        if (r.value) text += dec.decode(r.value);
        if (!booked && text.includes("event: hello")) {
          booked = true;
          await w.bookNow();
        }
        if (r.done && !r.value && !booked) break;
      }
      ctl.abort();
      return { status: res.status, text };
    });
    expect(raw.status).toBe(200);
    expect(raw.text).toContain("event: booked");
    for (const secret of [
      name,
      second,
      made.id,
      "patient_name",
      "appointment_id",
      "actor_email",
      "staff_reason",
    ]) {
      expect(raw.text).not.toContain(secret);
    }
  });

  test("a second viewer is told the feed is busy, and the page keeps refreshing instead", async ({
    as,
    browser,
  }) => {
    const first = await as("owner");
    await live(first);

    const context = await browser.newContext();
    const { signIn } = await import("./support/fixtures");
    await signIn(context, EMAIL.admin);
    const second = await context.newPage();
    await second.goto("/dashboard");
    const status = second.getByTestId("live-status");
    await expect(status).toHaveAttribute("data-status", "busy");
    await expect(status).toHaveText("Live feed busy, refreshing every 30 s");
    // The rest of the dashboard still works.
    await expect(second.getByTestId("kpi-upcoming-booked")).toBeVisible();
    await context.close();

    // The first one is still live.
    await expect(first.getByTestId("live-status")).toHaveAttribute(
      "data-status",
      "live",
    );
  });

  test("revoking a person's access ends their live feed", async ({
    browser,
  }) => {
    const email = `e2e-live-revoke-${Date.now()}@clinic.example`;
    const granted = await internal(
      "POST",
      "/internal/admin/access",
      { email: OWNER, role: "owner" },
      { email, role: "admin" },
    );
    expect(granted.status).toBe(201);
    const context = await browser.newContext();
    const { signIn } = await import("./support/fixtures");
    await signIn(context, email);
    const page = await context.newPage();
    await live(page);

    const revoked = await internal(
      "DELETE",
      `/internal/admin/access/${encodeURIComponent(email)}`,
      { email: OWNER, role: "owner" },
    );
    expect(revoked.status).toBe(200);
    // The gateway re-reads the role every ROLE_RECHECK (2 s here, 30 s in production), closes the
    // stream, and the reconnect is refused because the database no longer says admin.
    await expect(page.getByTestId("live-status")).toHaveAttribute(
      "data-status",
      "denied",
      { timeout: 15_000 },
    );
    await context.close();
  });

  test("a staff veto shows in the feed, and on the open appointment page, within 2 seconds", async ({
    as,
  }) => {
    const page = await as("owner");
    await live(page);
    const first = await book(`Live Veto ${Date.now()}`);
    await patientReschedules(first);

    const vetoed = await internal(
      "POST",
      `/internal/admin/appointments/${first.id}/veto`,
      ADMIN,
      { reason: "Doctor asked to keep the original time" },
    );
    expect(vetoed.status).toBe(200);
    const row = page
      .getByTestId("live-event")
      .filter({ hasText: `Vetoed by ${EMAIL.admin}` });
    await expect(row).toBeVisible({ timeout: 2000 });
    await expect(row).toHaveAttribute("data-kind", "vetoed");
    await expect(row).toContainText("Doctor asked to keep the original time");
    await expect(row).toContainText(first.name);

    // The appointment page reads the browser's one shared stream and keeps its own appointment's
    // events. A full page load ends the dashboard's stream and starts the page's.
    const second = await book(`Live Veto Page ${Date.now()}`);
    await patientReschedules(second);
    await page.goto(`/dashboard/appointments/${second.id}`);
    const status = page.getByTestId("appointment-live");
    await expect(status).toHaveAttribute("data-status", "live");
    const moves = page.getByTestId("lineage-rescheduled");
    await expect(moves).toHaveCount(1);

    const again = await internal(
      "POST",
      `/internal/admin/appointments/${second.id}/veto`,
      ADMIN,
      { reason: "Keep the booked time" },
    );
    expect(again.status).toBe(200);
    // The veto moves the visit back: the history gains that move without a reload.
    await expect(moves).toHaveCount(2, { timeout: 2000 });
    await expect(status).not.toHaveAttribute("data-updated-at", "");
  });

  test("a row in the live feed opens its appointment", async ({ as }) => {
    const page = await as("owner");
    await live(page);
    const name = `Live Row ${Date.now()}`;
    const made = await book(name);
    const row = page.getByTestId("live-event").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 2000 });
    await row.getByRole("link").click();
    await expect(page.getByTestId("sheet-patient")).toHaveText(name);
    await page.getByRole("link", { name: "Open the full page" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/appointments/${made.id}$`),
    );
    await expect(page.getByTestId("appointment-patient")).toHaveText(name);
  });

  test("a veto made from the appointment page shows on another person's open page within 2 seconds", async ({
    as,
    browser,
  }) => {
    // Setting up (booking through the API, two browsers, the page loads) is slow on a cold app; the
    // 2 second assertions below are the ones that measure the feed.
    test.setTimeout(60_000);
    const made = await book(`Live Veto UI ${Date.now()}`);
    await patientReschedules(made);
    const ownerPage = await as("owner");
    await ownerPage.goto(`/dashboard/appointments/${made.id}`);
    await expect(ownerPage.getByTestId("appointment-live")).toHaveAttribute(
      "data-status",
      "live",
    );
    await expect(ownerPage.getByTestId("lineage-rescheduled")).toHaveCount(1);

    const ctx = await browser.newContext();
    // The local gateway serves one stream at a time and the owner's page holds it, so the admin's
    // page (which only does the action) must not open one of its own and compete for the slot.
    await ctx.route("**/live/stream**", (route) => route.abort());
    await signIn(ctx, EMAIL.admin);
    const adminPage = await ctx.newPage();
    await adminPage.goto(`/dashboard/appointments/${made.id}`);
    await tap(adminPage.getByRole("button", { name: "Veto and lock" }));
    const dialog = adminPage.getByRole("dialog", {
      name: "Undo the patient's last change?",
    });
    await dialog.getByLabel("Reason").fill("Doctor needs the original time");
    await dialog.getByRole("button", { name: "Veto and lock" }).click();
    await expect(adminPage.getByTestId("locked-note")).toBeVisible();

    // The owner's page, which never reloaded, gains the move back and the lock.
    await expect(ownerPage.getByTestId("lineage-rescheduled")).toHaveCount(2, {
      timeout: 2000,
    });
    await expect(ownerPage.getByTestId("locked-note")).toBeVisible({
      timeout: 2000,
    });
    await ctx.close();
  });

  test("an arrival marked on the appointment page shows on another person's open page within 2 seconds", async ({
    as,
    browser,
  }) => {
    // Setting up (booking through the API, two browsers, the page loads) is slow on a cold app; the
    // 2 second assertions below are the ones that measure the feed.
    test.setTimeout(60_000);
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const made = await book(`Live Arrival ${Date.now()}`);
    moveToPastHalfHour(made.id, 1);
    const ownerPage = await as("owner");
    await ownerPage.goto(`/dashboard/appointments/${made.id}`);
    await expect(ownerPage.getByTestId("appointment-live")).toHaveAttribute(
      "data-status",
      "live",
    );
    const badge = ownerPage.locator('main [data-slot="badge"]');
    await expect(badge).toHaveText(/Booked/);

    const ctx = await browser.newContext();
    // The local gateway serves one stream at a time and the owner's page holds it, so the admin's
    // page (which only does the action) must not open one of its own and compete for the slot.
    await ctx.route("**/live/stream**", (route) => route.abort());
    await signIn(ctx, EMAIL.admin);
    const adminPage = await ctx.newPage();
    await adminPage.goto(`/dashboard/appointments/${made.id}`);
    await tap(adminPage.getByRole("button", { name: "Mark arrived" }));
    {
      const ask = adminPage.getByRole("dialog", { name: "Mark as arrived?" });
      await ask.getByLabel("Reason").fill("patient is at the desk");
      await ask.getByRole("button", { name: "Mark arrived" }).click();
    }
    await expect(adminPage.getByText("Marked arrived.")).toBeVisible();

    await expect(badge).toHaveText(/Arrived/, { timeout: 2000 });
    await ctx.close();
  });
});

/** Every request a page makes to the admin app's stream route. */
function streamRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/live/stream") seen.push(r.url());
  });
  return seen;
}

async function appointmentLive(page: Page, id: string) {
  await page.goto(`/dashboard/appointments/${id}`);
  await expect(page.getByTestId("appointment-live")).toHaveAttribute(
    "data-status",
    "live",
  );
}

// One browser, one stream: the tabs elect a leader that holds the only stream and passes its
// events to the others (src/lib/live-share.ts). Counted where it costs, on the gateway: its own
// "stream opened" log line in the compose stack.
test.describe("one stream per browser", () => {
  test("the dashboard and an appointment page in two tabs hold exactly one upstream stream", async ({
    as,
  }) => {
    const made = await book(`Two Tabs ${Date.now()}`);
    const since = Date.now();
    const dash = await as("owner");
    const dashRequests = streamRequests(dash);
    await live(dash);
    const appt = await dash.context().newPage();
    const apptRequests = streamRequests(appt);
    await appointmentLive(appt, made.id);
    await dash.waitForTimeout(3000); // time for a second stream to show, if one were opened

    const streams = opened(since).filter((l) => l.role === "owner");
    expect(streams).toHaveLength(1);
    expect(dashRequests.length + apptRequests.length).toBe(1);
    // ...and the stream is the whole clinic's, not filtered to one appointment.
    expect(streams[0].filtered).toBe(false);
    expect(apptRequests.concat(dashRequests)[0]).not.toContain("appointment=");
  });

  test("an event while both are open reaches both tabs within 2 seconds", async ({
    as,
  }) => {
    const made = await book(`Both Tabs ${Date.now()}`);
    const dash = await as("owner");
    await live(dash);
    const appt = await dash.context().newPage();
    await appointmentLive(appt, made.id);
    const moves = appt.getByTestId("lineage-rescheduled");
    await expect(moves).toHaveCount(0);

    // A new booking: the dashboard's feed shows it.
    const other = await book(`Both Tabs New ${Date.now()}`);
    await expect(
      dash.getByTestId("live-event").filter({ hasText: other.name }),
    ).toBeVisible({ timeout: 2000 });

    // A change to the open appointment: both tabs show it, from the one stream.
    await patientReschedules(made);
    await expect(
      dash
        .getByTestId("live-event")
        .filter({ hasText: made.name })
        .and(dash.locator('[data-kind="rescheduled"]')),
    ).toBeVisible({ timeout: 2000 });
    await expect(moves).toHaveCount(1, { timeout: 2000 });
    await expect(appt.getByTestId("appointment-live")).not.toHaveAttribute(
      "data-updated-at",
      "",
    );
  });

  test("closing the leader tab hands the stream over without losing or repeating an event", async ({
    as,
  }) => {
    const made = await book(`Handover ${Date.now()}`);
    const since = Date.now();
    // The appointment page opens first, so it leads; the dashboard follows.
    const leader = await as("owner");
    await appointmentLive(leader, made.id);
    const follower = await leader.context().newPage();
    await live(follower);
    const before = `Handover Before ${Date.now()}`;
    await book(before);
    await expect(
      follower.getByTestId("live-event").filter({ hasText: before }),
    ).toBeVisible({ timeout: 2000 });

    // Close the leader, and book at once: these happen while no tab holds a stream.
    await leader.close();
    const gap = [
      `Handover Gap A ${Date.now()}`,
      `Handover Gap B ${Date.now()}`,
    ];
    for (const name of gap) await book(name);

    for (const name of [before, ...gap]) {
      await expect(
        follower.getByTestId("live-event").filter({ hasText: name }),
      ).toHaveCount(1, { timeout: 5000 });
    }
    await expect(follower.getByTestId("live-status")).toHaveAttribute(
      "data-status",
      "live",
    );
    const streams = opened(since).filter((l) => l.role === "owner");
    expect(streams).toHaveLength(2);
    // The new leader resumed from the last event the old one passed on.
    expect(streams[1].resumed).toBe(true);
  });

  test("when the gateway has no free slot both pages say so, and the data still updates within 30 seconds", async ({
    as,
  }) => {
    test.setTimeout(120_000);
    const made = await book(`Overflow ${Date.now()}`);
    const release = await holdSlot(EMAIL.admin, "admin");
    try {
      const dash = await as("owner");
      await dash.goto("/dashboard");
      const status = dash.getByTestId("live-status");
      await expect(status).toHaveAttribute("data-status", "busy");
      await expect(status).toHaveText("Live feed busy, refreshing every 30 s");
      const appt = await dash.context().newPage();
      await appt.goto(`/dashboard/appointments/${made.id}`);
      const apptStatus = appt.getByTestId("appointment-live");
      await expect(apptStatus).toHaveAttribute("data-status", "busy");
      await expect(apptStatus).toHaveText(
        "Live updates busy, refreshing every 30 s",
      );

      // No stream, but the numbers and the history still move: the 30 s refresh.
      const upcoming = dash.getByTestId("kpi-upcoming-booked");
      const was = Number(await upcoming.textContent());
      await book(`Overflow New ${Date.now()}`);
      await patientReschedules(made);
      // At least one more than shown (the cached figure may also predate the booking above).
      await expect
        .poll(async () => Number(await upcoming.textContent()), {
          timeout: 35_000,
        })
        .toBeGreaterThan(was);
      await expect(appt.getByTestId("lineage-rescheduled")).toHaveCount(1, {
        timeout: 35_000,
      });
      await expect(status).toHaveAttribute("data-status", "busy");
    } finally {
      await release();
    }
  });
});
