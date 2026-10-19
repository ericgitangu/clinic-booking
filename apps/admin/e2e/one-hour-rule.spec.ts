// Staff and the one-hour rule: inside the last hour before a visit the screen still disables
// cancel and reschedule with a visible reason, but the API does not refuse staff (it exempts them
// from the lead-time rule and nothing else; patients get 409 CHANGE_TOO_LATE). The
// appointment is booked through the public API for a far-off time, then moved into the window in
// the database, because nothing public can book it there.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { formatTime } from "../src/lib/clinic-time";
import { OWNER, internal, publicApi } from "./support/stack";
import { expect, test } from "./support/fixtures";

// Reach the stack under test the way whoever started it did. A run that set COMPOSE_PROJECT_NAME
// (scripts/e2e_admin.sh does) is followed by name; CI starts the stack with a plain
// `docker compose up` from the repository root, so there the compose file's own default project
// applies and no name is passed. Playwright runs from apps/admin, hence the path.
const COMPOSE_FILE = path.resolve(process.cwd(), "../../docker-compose.yml");
const COMPOSE_ARGS = [
  "compose",
  ...(process.env.COMPOSE_PROJECT_NAME
    ? ["-p", process.env.COMPOSE_PROJECT_NAME]
    : []),
  "-f",
  COMPOSE_FILE,
];

function moveTo(id: string, minutesAhead: number) {
  // The half hour at or just before now + minutesAhead, i.e. 0 to 30 minutes earlier than that.
  const at = `now() + interval '${minutesAhead} minutes'`;
  const slot = `date_trunc('hour', ${at})
    + CASE WHEN extract(minute FROM ${at}) >= 30 THEN interval '30 minutes' ELSE interval '0' END`;
  execFileSync(
    "docker",
    [
      ...COMPOSE_ARGS,
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "clinic",
      "-d",
      "clinic",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      // A rerun on the same database finds an earlier run's visit in that slot: free it first.
      `UPDATE appointments SET status = 'cancelled', cancelled_at = now(),
           cancellation_reason = 'e2e: slot reused'
         WHERE starts_at = ${slot} AND status = 'booked' AND id <> '${id}'
           AND doctor_id = (SELECT doctor_id FROM appointments WHERE id = '${id}');
       UPDATE appointments SET starts_at = ${slot}, ends_at = ${slot} + interval '30 minutes'
         WHERE id = '${id}' AND status = 'booked'`,
    ],
    { stdio: "pipe" },
  );
}

const moveIntoTheLastHour = (id: string) => moveTo(id, 50);

test("inside the last hour the screen disables the actions and says why, while the API lets staff move the visit", async ({
  as,
}) => {
  const id = await bookOneStraightThroughTheApi();
  moveIntoTheLastHour(id);
  const page = await as("owner");
  await page.goto(`/dashboard/appointments/${id}`);
  const cancel = page.getByRole("button", { name: "Cancel appointment" });
  const move = page.getByRole("button", { name: "Reschedule" });
  await expect(cancel).toBeDisabled();
  await expect(move).toBeDisabled();
  const note = page.getByText(/starts in less than an hour/i);
  await expect(note).toBeVisible(); // visible text, not a hover-only tooltip
  await expect(cancel).toHaveAttribute("aria-describedby", "change-note");
  await expect(move).toHaveAttribute("aria-describedby", "change-note");
  await expect(note).toHaveAttribute("id", "change-note");

  // The API lets staff through: the lead-time rule binds patients, not the clinic. (The screen
  // still disables the buttons; the admin screens lift that for owner and admin.) A move rather
  // than a cancel, so the other scenarios' cancellation counts are not disturbed.
  const monday = new Date();
  monday.setUTCDate(
    monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7) + 14,
  );
  const day = monday.toISOString().slice(0, 10);
  const res = await internal<{ audit_id: string | null }>(
    "PATCH",
    `/internal/admin/appointments/${id}/reschedule`,
    { email: OWNER, role: "owner" },
    {
      starts_at: `${day}T11:30:00+03:00`,
      reason: "staff move inside the hour",
    },
  );
  expect(res.status).toBe(200);
  expect(res.body.audit_id).toBeTruthy();
});

test("a dialog open when the visit comes within the hour closes and a toast says why", async ({
  as,
}) => {
  const id = await bookOneStraightThroughTheApi();
  moveTo(id, 100); // 70 to 100 minutes away: outside the hour when the page is drawn
  const page = await as("owner");
  await page.clock.install({ time: new Date() });
  await page.goto(`/dashboard/appointments/${id}`);
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByLabel("Reason")).toBeVisible();
  // 45 minutes pass with the dialog open; the page looks again every 30 seconds.
  await page.clock.fastForward(45 * 60_000);
  await expect(page.getByLabel("Reason")).toHaveCount(0);
  await expect(
    page.getByText(
      "This visit now starts in less than an hour, so it can no longer be cancelled or moved.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel appointment" }),
  ).toBeDisabled();
});

test("the times offered for moving a visit are only that visit's doctor's free times", async ({
  as,
}) => {
  const id = await bookOneStraightThroughTheApi();
  const appt = await publicApi<{ doctor_id: string; starts_at: string }>(
    "GET",
    `/appointments/${id}`,
  );
  const doctorId = appt.body.doctor_id;
  // A day with free times for this doctor, a few days after the booking.
  let day = "";
  let own: string[] = [];
  for (let ahead = 5; ahead < 40 && own.length === 0; ahead++) {
    day = new Date(Date.parse(appt.body.starts_at) + ahead * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const avail = await publicApi<{ slots: { starts_at: string }[] }>(
      "GET",
      `/doctors/${doctorId}/availability?date=${day}`,
    );
    own = avail.body.slots.map((x) => formatTime(x.starts_at));
  }
  expect(own.length).toBeGreaterThan(0);
  // Another doctor's free times that day, to be sure the list is not just "all times".
  const doctors = await publicApi<{ items: { id: string }[] }>(
    "GET",
    "/doctors",
  );
  const others: string[] = [];
  for (const d of doctors.body.items.filter((x) => x.id !== doctorId)) {
    const a = await publicApi<{ slots: { starts_at: string }[] }>(
      "GET",
      `/doctors/${d.id}/availability?date=${day}`,
    );
    others.push(a.body.slots.map((x) => formatTime(x.starts_at)).join(","));
  }

  const page = await as("owner");
  await page.goto(`/dashboard/appointments/${id}`);
  await page.getByRole("button", { name: "Reschedule" }).click();
  await page.getByLabel("Day").fill(day);
  const trigger = page.locator("#move-slot");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const shown = await page.getByRole("option").allTextContents();
  expect(shown).toEqual(own);
  expect(others.some((o) => o !== own.join(","))).toBe(true); // the check can tell doctors apart
});
