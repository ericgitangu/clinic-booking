// The one-hour rule for staff: inside the last hour before a visit, cancel and reschedule are
// disabled with a visible reason, and the API refuses them anyway (409 CHANGE_TOO_LATE). The
// appointment is booked through the public API for a far-off time, then moved into the window in
// the database, because nothing public can book it there.
import { execFileSync } from "node:child_process";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { OWNER, internal } from "./support/stack";
import { expect, test } from "./support/fixtures";

function moveTo(id: string, minutesAhead: number) {
  // The half hour at or just before now + minutesAhead, i.e. 0 to 30 minutes earlier than that.
  const at = `now() + interval '${minutesAhead} minutes'`;
  const slot = `date_trunc('hour', ${at})
    + CASE WHEN extract(minute FROM ${at}) >= 30 THEN interval '30 minutes' ELSE interval '0' END`;
  execFileSync(
    "docker",
    [
      "compose",
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
         WHERE starts_at = ${slot} AND status = 'booked' AND id <> '${id}';
       UPDATE appointments SET starts_at = ${slot}, ends_at = ${slot} + interval '30 minutes'
         WHERE id = '${id}' AND status = 'booked'`,
    ],
    { stdio: "pipe" },
  );
}

const moveIntoTheLastHour = (id: string) => moveTo(id, 50);

test("inside the last hour staff cannot cancel or move a visit, and are told why", async ({
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

  // The API holds the line whatever the screen shows.
  const body = { reason: "staff cancel attempt" };
  const res = await internal<{ code: string }>(
    "PATCH",
    `/internal/admin/appointments/${id}/cancel`,
    { email: OWNER, role: "owner" },
    body,
  );
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("CHANGE_TOO_LATE");
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
