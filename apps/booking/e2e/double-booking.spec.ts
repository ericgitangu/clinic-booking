import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { hhmm } from "./api";
import { farCell, sharedLateTime } from "./support/cells";
import { newPerson, sessionCookies } from "./support/auth";
import { IDLE_MS } from "../src/lib/polling";

// The grid, the confirm step and the booking action must all refuse a double booking, and say so in
// words, not only the database. Real stack: this build, the real API and Postgres. Instance
// i = repeat * SCENARIOS + scenario owns calendar cell i (support/cells.ts), so repeats and workers
// never share a day. Cross-doctor checks use a time late in the day that no other test books.
const SCENARIOS = 10;
const cellOf = (scenario: number, repeat: number) =>
  repeat * SCENARIOS + scenario;

let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 200) + 50}.${(nextIp++ % 250) + 1}`;

type Person = ReturnType<typeof newPerson>;
async function signedIn(browser: Browser, person: Person = newPerson()) {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  await context.addCookies(await sessionCookies(person));
  return { context, page: await context.newPage(), person };
}

const grid = (doctorId: string, day: string) => `/book/${doctorId}?date=${day}`;
const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;
const chip = (page: Page, startsAt: string) =>
  page.getByRole("radio", { name: new RegExp(`^${hhmm(startsAt)}`) });
const armed = (page: Page) =>
  expect(page.locator("[data-polling]")).toHaveAttribute(
    "data-polling",
    "armed",
  );

async function bookOn(page: Page, doctorId: string, startsAt: string) {
  await page.goto(details(doctorId, startsAt));
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
}

async function closeAll(...c: BrowserContext[]) {
  for (const x of c) await x.close();
}

test("a time the patient already holds is inactive on the grid and says so", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(0, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  await bookOn(me.page, doctorId, slots[1]);

  await me.page.goto(grid(doctorId, day));
  const mine = chip(me.page, slots[1]);
  await expect(mine).toBeDisabled();
  await expect(mine).toHaveAttribute("aria-disabled", "true");
  await expect(mine).toHaveAccessibleName(/Your visit/);
  await expect(chip(me.page, slots[2])).toBeEnabled();

  // A visitor who is not signed in learns nothing about it.
  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const other = await visitor.newPage();
  await other.goto(grid(doctorId, day));
  await expect(chip(other, slots[2])).toBeEnabled();
  await expect(other.getByText("Your visit")).toHaveCount(0);
  await closeAll(me.context, visitor);
});

test("a time the patient holds with another doctor is inactive on this doctor's grid", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(1, testInfo.repeatEachIndex),
  );
  const { other: elsewhere, startsAt: t } = await sharedLateTime(
    day,
    doctorId,
    slots,
  );
  const me = await signedIn(browser);
  await bookOn(me.page, doctorId, t);

  await me.page.goto(grid(elsewhere, day));
  const c = chip(me.page, t);
  await expect(c).toBeDisabled();
  await expect(c).toHaveAccessibleName(/You have another visit/);
  await closeAll(me.context);
});

test("the confirm step refuses a time the patient already holds, before the API is asked", async ({
  browser,
}, testInfo) => {
  const { doctorId, slots } = await farCell(
    cellOf(2, testInfo.repeatEachIndex),
  );
  const a = await signedIn(browser);
  // Page A opens the confirm step for a time, then page B (same person) books that time.
  await a.page.goto(details(doctorId, slots[2]));
  const confirm = a.page.getByRole("button", { name: "Confirm booking" });
  await expect(confirm).toBeEnabled();
  const b = await a.context.newPage();
  await bookOn(b, doctorId, slots[2]);

  await confirm.click();
  const alert = a.page.locator('[role="alert"]:not(#__next-route-announcer__)');
  await expect(alert).toContainText("You already have a visit with");
  await expect(alert).toContainText("My appointments");
  await expect(
    alert.getByRole("link", { name: "My appointments" }),
  ).toBeVisible();

  // Opening the confirm step afresh for that time does not offer a booking at all.
  await a.page.goto(details(doctorId, slots[2]));
  await expect(
    a.page.getByRole("heading", {
      name: "You already have a visit at this time",
    }),
  ).toBeVisible();
  await expect(
    a.page.getByRole("button", { name: "Confirm booking" }),
  ).toHaveCount(0);
  await closeAll(a.context);
});

test("a time someone else takes stays in place as an inactive Booked chip", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(3, testInfo.repeatEachIndex),
  );
  const viewer = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await viewer.newPage();
  await page.clock.install();
  await page.goto(grid(doctorId, day));
  await armed(page);
  const order = () =>
    page
      .getByRole("radio")
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  const before = await order();

  const other = await signedIn(browser);
  await bookOn(other.page, doctorId, slots[1]);

  await page.clock.runFor(16_000);
  const gone = chip(page, slots[1]);
  await expect(gone).toBeDisabled();
  // The API lists every booked time, so the chip says Booked (a time that merely left the list,
  // with no such answer, would read No longer available).
  await expect(gone).toHaveAccessibleName(/Booked/);
  expect(await order()).toEqual(before); // nothing moved under a finger
  await closeAll(viewer, other.context);
});

test("after the patient's own booking, going back shows that time inactive without a reload", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(4, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  const page = me.page;
  await page.goto(grid(doctorId, day));
  await page.evaluate(() => {
    (window as unknown as { __kept: boolean }).__kept = true;
  });
  await chip(page, slots[1]).check({ force: true });
  await page.getByRole("link", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "My appointments" }).first(),
  ).toBeVisible();

  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/book/${doctorId}\\?date=`));
  await expect(chip(page, slots[1])).toBeDisabled();
  await expect(chip(page, slots[1])).toHaveAccessibleName(/Your visit/);
  expect(
    await page.evaluate(
      () => (window as unknown as { __kept?: boolean }).__kept,
    ),
  ).toBe(true);
  await closeAll(me.context);
});

test("a double click on Confirm makes one booking and shows one result", async ({
  browser,
}, testInfo) => {
  const { doctorId, slots } = await farCell(
    cellOf(5, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  await me.page.goto(details(doctorId, slots[1]));
  await expect(
    me.page.getByRole("button", { name: "Confirm booking" }),
  ).toBeEnabled();
  await me.page.getByRole("button", { name: "Confirm booking" }).dblclick();
  await expect(
    me.page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();

  await me.page.goto("/appointments");
  await expect(me.page.getByText(hhmm(slots[1]))).toHaveCount(1);
  await closeAll(me.context);
});

for (const [n, scheme] of [
  [6, "light"],
  [7, "dark"],
] as const) {
  test(`the grid states are accessible and usable (${scheme})`, async ({
    browser,
  }, testInfo) => {
    const { doctorId, day, slots } = await farCell(
      cellOf(n, testInfo.repeatEachIndex),
    );
    const me = await signedIn(browser);
    await me.page.emulateMedia({
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await bookOn(me.page, doctorId, slots[1]);
    await me.page.goto(grid(doctorId, day));
    await armed(me.page);
    const mine = chip(me.page, slots[1]);
    await expect(mine).toBeDisabled();

    const { violations } = await new AxeBuilder({ page: me.page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      ),
      JSON.stringify(
        violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
      ),
    ).toEqual([]);

    // An inactive chip cannot take focus; a free one can.
    await mine.focus().catch(() => {});
    expect(
      await me.page.evaluate(
        () => (document.activeElement as HTMLInputElement)?.disabled,
      ),
    ).not.toBe(true);
    // 44 px targets, also for the inactive ones.
    const label = me.page.locator("label", { has: mine });
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    // No motion when the person asks for none.
    const duration = await label
      .locator(".slot-chip-label")
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration.split(",").every((d) => parseFloat(d) === 0)).toBe(true);
    await closeAll(me.context);
  });
}

test("when polling has paused the page says so in the words the hint uses", async ({
  browser,
}, testInfo) => {
  const { doctorId, day } = await farCell(cellOf(8, testInfo.repeatEachIndex));
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await ctx.newPage();
  await page.clock.install();
  await page.goto(grid(doctorId, day));
  await armed(page);
  await page.clock.fastForward(IDLE_MS + 1000);
  await expect(
    page.getByRole("button", { name: "Paused. Click to refresh." }),
  ).toBeVisible();
  await expect(page.getByTestId("refresh-hint")).not.toContainText("try again");
  await ctx.close();
});

test("losing the race on a move (a confirmed 409) shows that time as an inactive chip, in place", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(9, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  await bookOn(me.page, doctorId, slots[1]);
  const id = me.page.url().split("/").pop();
  await me.page.goto(`/appointments/${id}/reschedule?date=${day}`);
  await armed(me.page);
  await chip(me.page, slots[3]).check({ force: true });

  // Someone else takes that time after this page loaded, before the move is sent.
  const other = await signedIn(browser);
  await bookOn(other.page, doctorId, slots[3]);

  await me.page.getByRole("button", { name: "Move appointment" }).click();
  await expect(
    me.page.locator('[role="alert"]:not(#__next-route-announcer__)'),
  ).toContainText("That time was just taken.");
  const lost = chip(me.page, slots[3]);
  await expect(lost).toBeDisabled();
  await expect(lost).toHaveAccessibleName(/Booked/); // the API lists it as taken, which wins
  await closeAll(me.context, other.context);
});
