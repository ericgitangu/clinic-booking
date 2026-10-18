import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { farCell } from "./support/cells";
import { withDb } from "./support/db";
import { newPerson, sessionCookies } from "./support/auth";

// Every page this work added or changed, in light and dark, checked with axe (WCAG 2.2 AA tags, all
// impacts, no exclusions). Real stack. Instance i = repeat * 2 + scheme owns calendar cell 60 + i.
const cellOf = (scheme: number, repeat: number) => 60 + repeat * 2 + scheme;

let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 50) + 80}.${(nextIp++ % 250) + 1}`;

async function clean(page: Page, view: string) {
  // Colour contrast is read from what is painted, so let any opening animation (a dialog fading in)
  // finish first.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    violations.map((v) => [v.id, v.impact, v.nodes.map((n) => n.target)]),
    view,
  ).toEqual([]);
}

for (const [i, scheme] of (["light", "dark"] as const).entries()) {
  test(`axe is clean on every new view (${scheme})`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const { doctorId, day, slots } = await farCell(
      cellOf(i, testInfo.repeatEachIndex),
    );
    const context = await browser.newContext({
      colorScheme: scheme,
      reducedMotion: "reduce",
      extraHTTPHeaders: { "x-forwarded-for": ip() },
    });
    await context.addCookies(await sessionCookies(newPerson()));
    const page = await context.newPage();

    await page.goto("/");
    await clean(page, "landing");
    await page.goto("/book");
    await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
    await clean(page, "doctor list with portraits");
    await page.goto(`/book/${doctorId}?date=${day}`);
    await expect(
      page.getByRole("link", { name: / free, book this time$/ }).first(),
    ).toBeVisible();
    await clean(page, "slot page");
    await page.goto(`/book/${doctorId}?date=${day}&notice=taken`);
    await expect(
      page.getByRole("status").filter({ hasText: "no longer free" }),
    ).toBeVisible();
    await clean(page, "slot page with a notice");
    await page.locator("body").press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await clean(page, "shortcut dialog");
    await page.keyboard.press("Escape");

    const book = async (startsAt: string) => {
      await page.goto(
        `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`,
      );
      await clean(page, "details");
      await page.getByRole("button", { name: "Confirm booking" }).click();
      await expect(
        page.getByRole("heading", { name: "You are booked" }),
      ).toBeVisible();
      return page.url().split("/").pop()!;
    };
    await book(slots[1]);
    await clean(page, "confirmation");

    await page.goto("/appointments");
    await expect(
      page.getByRole("heading", { name: "My appointments" }),
    ).toBeVisible();
    await clean(page, "my appointments with clickable cards");
    await page.goto("/appointments");
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
    await clean(page, "appointment page");
    const id = page.url().split("/").pop()!;
    await page.goto(`/appointments/${id}/reschedule?date=${day}`);
    await expect(page.getByRole("radio").first()).toBeVisible();
    await clean(page, "reschedule");

    await page.goto(`/appointments/${id}`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByLabel("Why are you cancelling?").fill("Plans changed");
    await clean(page, "cancel dialog");
    await page.getByRole("button", { name: "Cancel appointment" }).click();
    await expect(
      page.getByRole("heading", { name: "Appointment cancelled" }),
    ).toBeVisible();
    await clean(page, "cancelled view");

    const pastId = await book(slots[2]);
    await withDb((db) =>
      db.query(
        `UPDATE appointments SET starts_at = starts_at - interval '200 days',
                ends_at = ends_at - interval '200 days' WHERE id = $1`,
        [pastId],
      ),
    );
    await page.goto(`/appointments/${pastId}`);
    await expect(
      page.getByRole("heading", { name: "This visit has passed" }),
    ).toBeVisible();
    await clean(page, "past visit");
    await context.close();
  });
}
