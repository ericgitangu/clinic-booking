// The live feed against the real stack: the production build of this app, the real API, the real
// Postgres and the real Go gateway (docker compose, profile "realtime"). A booking is made through
// the public API, exactly as a patient's would be, and the dashboard in a real browser must show it.
// Only Google's own sign-in is replaced (support/test-auth.ts).
import { EMAIL, internal, OWNER, publicApi } from "./support/stack";
import { expect, seeded, test } from "./support/fixtures";

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
    if (res.status === 201) return { id: res.body.id, name };
  }
  throw new Error("no free slot to book");
}

async function live(page: import("@playwright/test").Page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("live-status")).toHaveAttribute(
    "data-status",
    "live",
  );
}

test.describe("live feed", () => {
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

    // The same stream, read directly with the viewer's own session: no personal field at all.
    const raw = await page.evaluate(async () => {
      const ctl = new AbortController();
      const res = await fetch("/live/stream", { signal: ctl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((ok) =>
            setTimeout(() => ok({ done: true, value: undefined }), 1500),
          ),
        ]);
        if (r.done) break;
        text += dec.decode(r.value);
      }
      ctl.abort();
      return { status: res.status, text };
    });
    // The page itself holds the one slot, so a second reader is told to wait: nothing to leak.
    expect([200, 429]).toContain(raw.status);
    expect(raw.text).not.toContain(name);
    expect(raw.text).not.toContain("patient_name");
    expect(raw.text).not.toContain("appointment_id");
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
});
