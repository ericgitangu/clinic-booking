// The one-hour rule for staff: inside the last hour before a visit, cancel and reschedule are
// disabled with a visible reason, and the API refuses them anyway (409 CHANGE_TOO_LATE). The
// appointment is booked through the public API for a far-off time, then moved into the window in
// the database, because nothing public can book it there.
import { execFileSync } from "node:child_process";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { OWNER, internal } from "./support/stack";
import { expect, test } from "./support/fixtures";

function moveIntoTheLastHour(id: string) {
  const next30 = `date_trunc('hour', now() + interval '50 minutes')
    + CASE WHEN extract(minute FROM now() + interval '50 minutes') >= 30
           THEN interval '30 minutes' ELSE interval '0' END`;
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
      `UPDATE appointments SET starts_at = ${next30}, ends_at = ${next30} + interval '30 minutes'
         WHERE id = '${id}' AND status = 'booked'`,
    ],
    { stdio: "pipe" },
  );
}

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
