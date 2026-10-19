// The one-hour rule binds patients, not the clinic. Inside the last hour before a visit a patient
// cannot cancel or move it (409 CHANGE_TOO_LATE), and staff can: the screen keeps the buttons
// enabled and the API lets the change through with the staff member's reason. The appointment is
// booked through the public API for a far-off time, then moved into the window in the database,
// because nothing public can book it there.
import { moveToNextHalfHour } from "./support/clock";
import { bookOneStraightThroughTheApi } from "./support/booking";
import { OWNER, internal, publicApi } from "./support/stack";
import { expect, test } from "./support/fixtures";

test("inside the last hour staff can still cancel, with a reason, and a patient cannot", async ({
  as,
}) => {
  const id = await bookOneStraightThroughTheApi();
  moveToNextHalfHour(id);

  const patient = await publicApi<{ code: string }>(
    "PATCH",
    `/appointments/${id}/cancel`,
    { reason: "patient tries inside the hour" },
  );
  expect(patient.status).toBe(409);
  expect(patient.body.code).toBe("CHANGE_TOO_LATE");

  const page = await as("owner");
  await page.goto(`/dashboard/appointments/${id}`);
  const cancel = page.getByRole("button", { name: "Cancel appointment" });
  await expect(cancel).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reschedule" })).toBeEnabled();
  await expect(page.getByText(/starts in less than an hour/i)).toHaveCount(0);

  await cancel.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("clinic closed early today");
  await dialog.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Appointment cancelled.")).toBeVisible();

  const audit = await internal<{
    items: { action: string; reason: string; appointment_id: string }[];
  }>("GET", `/internal/admin/audit?appointment_id=${id}`, {
    email: OWNER,
    role: "owner",
  });
  expect(
    audit.body.items.some(
      (a) => a.action === "cancel" && a.reason === "clinic closed early today",
    ),
  ).toBe(true);
});
