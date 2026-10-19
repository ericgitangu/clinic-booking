import { expect, test, type Page } from "@playwright/test";
import { hhmm } from "./api";
import { farCell } from "./support/cells";
import { newPerson, sessionCookies } from "./support/auth";

// The doctor's portrait shows on every page that names the doctor, found the way a person finds it:
// an image whose accessible name is the doctor's name. Real stack. Instance i = repeat owns cell 80 + i.
const cellOf = (repeat: number) => 80 + repeat;

let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 40) + 140}.${(nextIp++ % 250) + 1}`;

async function expectPortrait(page: Page, name: string, size: number) {
  const img = page.getByRole("img", { name, exact: true }).first();
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("width", String(size));
  await expect(img).toHaveAttribute("height", String(size));
  // It really loaded (an image that failed has no width and the initials take its place).
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
}

test("the doctor's portrait is on the list, the slot page, the details page, the confirmation and the appointment", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(testInfo.repeatEachIndex),
  );
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  await context.addCookies(await sessionCookies(newPerson()));
  const page = await context.newPage();

  // The name of the doctor of this cell, read from the list the person sees.
  await page.goto("/book");
  const card = page
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href="/book/${doctorId}"]`) });
  const name = (await card.getByRole("heading").innerText()).trim();
  await expectPortrait(page, name, 56);
  await expect(
    page
      .getByRole("main")
      .getByText(/AI-generated portraits of fictional doctors/),
  ).toBeVisible();

  await page.goto(`/book/${doctorId}?date=${day}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expectPortrait(page, name, 64);

  await page
    .getByRole("link", { name: new RegExp(`^${hhmm(slots[2])} free`) })
    .click();
  await expect(
    page.getByRole("heading", { name: "Confirm your visit" }),
  ).toBeVisible();
  await expectPortrait(page, name, 56);

  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await expectPortrait(page, name, 56);

  await page.goto("/appointments");
  await expectPortrait(page, name, 48);
  await page
    .getByRole("main")
    .getByRole("listitem")
    .first()
    .getByRole("link")
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Your appointment" }),
  ).toBeVisible();
  await expectPortrait(page, name, 56);
  await context.close();
});
