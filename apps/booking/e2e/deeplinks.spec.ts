import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/csp-guard";
import { hhmm } from "./api";
import {
  chip,
  expectDesignedFocusRing,
  expectFree,
  expectInactive,
  tabTo,
} from "./support/chips";
import { farCell } from "./support/cells";
import { withDb } from "./support/db";
import { newPerson, sessionCookies } from "./support/auth";

// Deep links: a free time links to its details page, a taken or held time has no link, and each
// appointment has its own page (booked, or cancelled with the time freed). Real stack. Instance
// i = repeat * 10 + scenario owns calendar cell 40 + i (no other spec uses 40 to 99).
const cellOf = (scenario: number, repeat: number) =>
  40 + repeat * 10 + scenario;

let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 50) + 20}.${(nextIp++ % 250) + 1}`;

async function signedIn(browser: Browser) {
  const person = newPerson();
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  await context.addCookies(await sessionCookies(person));
  return { context, page: await context.newPage(), person };
}

const grid = (doctorId: string, day: string) => `/book/${doctorId}?date=${day}`;
const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;

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

test("a free time is a real link to its details page, reachable and activated by keyboard", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(0, testInfo.repeatEachIndex),
  );
  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await visitor.newPage();
  await page.goto(grid(doctorId, day));

  const link = page.getByRole("link", {
    name: `${hhmm(slots[2])} free, book this time`,
  });
  await expect(link).toHaveAttribute("href", details(doctorId, slots[2]));
  // A link, not a radio or a button, and nothing interactive inside it or around it.
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(link.getByRole("button")).toHaveCount(0);
  await expect(link.getByRole("link")).toHaveCount(0);

  // Keyboard: Tab reaches it, it shows the designed focus ring, and Enter follows it.
  await tabTo(page, link);
  await expect(link).toBeFocused();
  await expectDesignedFocusRing(link);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/book/${doctorId}/details\\?starts_at=`),
  );
  await expect(
    page.getByRole("heading", { name: "Confirm your visit" }),
  ).toBeVisible();
  await visitor.close();
});

test("tab order on the grid visits free times only, in time order", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(1, testInfo.repeatEachIndex),
  );
  const other = await signedIn(browser);
  await bookOn(other.page, doctorId, slots[1]);

  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await visitor.newPage();
  await page.goto(grid(doctorId, day));
  await expectInactive(page, slots[1], /Booked/);

  // Tab visits the free times only (the booked one is skipped), in time order.
  const links = page.getByRole("link", { name: / free, book this time$/ });
  const count = await links.count();
  expect(count).toBeGreaterThan(3);
  await expect(
    page.getByRole("link", { name: new RegExp(`^${hhmm(slots[1])}`) }),
  ).toHaveCount(0);
  await tabTo(page, links.first());
  for (let i = 0; i < count; i++) {
    await expect(links.nth(i)).toBeFocused();
    await page.keyboard.press("Tab");
  }
  await closeAll(other.context, visitor);
});

test("a time someone else booked and a time I hold have no link", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(2, testInfo.repeatEachIndex),
  );
  const other = await signedIn(browser);
  await bookOn(other.page, doctorId, slots[1]);
  const me = await signedIn(browser);
  await bookOn(me.page, doctorId, slots[2]);

  await me.page.goto(grid(doctorId, day));
  await expectInactive(me.page, slots[1], /Booked/);
  await expectInactive(me.page, slots[2], /Your visit/);
  await expectFree(me.page, slots[3]);

  const { violations } = await new AxeBuilder({ page: me.page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
    JSON.stringify(violations.map((v) => [v.id, v.nodes.map((n) => n.target)])),
  ).toEqual([]);
  await closeAll(other.context, me.context);
});

test("each appointment card links to its page; cancelling shows the cancelled view and frees the time", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(3, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  const page = me.page;
  await bookOn(page, doctorId, slots[3]);

  await page.goto("/appointments");
  const card = page
    .getByRole("listitem")
    .filter({ hasText: hhmm(slots[3]) })
    .first();
  await card.getByRole("link", { name: new RegExp(hhmm(slots[3])) }).click();
  await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("heading", { name: "Your appointment" }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(hhmm(slots[3])))).toBeVisible();
  await expect(page.getByRole("link", { name: "Reschedule" })).toBeVisible();

  const id = page.url().split("/").pop();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("Plans changed");
  await page.getByRole("button", { name: "Cancel appointment" }).click();

  await expect(
    page.getByRole("heading", { name: "Appointment cancelled" }),
  ).toBeVisible();
  await expect(page.getByText(/is free again/)).toBeVisible();
  await expect(page.getByText("Reason you gave: Plans changed")).toBeVisible();
  await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  // The same address, opened afresh, still says so.
  await page.goto(`/appointments/${id}`);
  await expect(page.getByText(/is free again/)).toBeVisible();

  // And the grid offers the time as a link again.
  await page.goto(grid(doctorId, day));
  await expectFree(page, slots[3]);
  await closeAll(me.context);
});

test("someone else's appointment id is a 404, and a signed-out visitor is asked to sign in", async ({
  browser,
}, testInfo) => {
  const { doctorId, slots } = await farCell(
    cellOf(4, testInfo.repeatEachIndex),
  );
  const owner = await signedIn(browser);
  await bookOn(owner.page, doctorId, slots[4]);
  await owner.page.goto("/appointments");
  await owner.page
    .getByRole("listitem")
    .filter({ hasText: hhmm(slots[4]) })
    .first()
    .getByRole("link", { name: new RegExp(hhmm(slots[4])) })
    .click();
  await expect(owner.page).toHaveURL(/\/appointments\/[0-9a-f-]{36}$/);
  const path = new URL(owner.page.url()).pathname;

  const stranger = await signedIn(browser);
  await stranger.page.goto(path);
  await expect(
    stranger.page.getByRole("heading", { name: "We could not find that page" }),
  ).toBeVisible();
  await expect(
    stranger.page.getByRole("heading", { name: "Your appointment" }),
  ).toHaveCount(0);

  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(path);
  await expect(
    anonPage.getByRole("heading", { name: "Sign in to see your appointment" }),
  ).toBeVisible();
  await closeAll(owner.context, stranger.context, anon);
});

test("doctor avatars show, with explicit sizes, on the list, the slot page and the confirmation", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(5, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  const page = me.page;

  const sized = async (selector: string, size: string) => {
    const img = page.locator(selector).first();
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("width", size);
    await expect(img).toHaveAttribute("height", size);
    expect(
      await img.evaluate((el: HTMLImageElement) => el.naturalWidth),
    ).toBeGreaterThan(0);
  };

  await page.goto("/book");
  await sized(`li:has(a[href="/book/${doctorId}"]) img`, "56");
  await page.goto(grid(doctorId, day));
  await sized("section img", "64");
  await bookOn(page, doctorId, slots[5]);
  await sized("section img", "56");
  await closeAll(me.context);
});

test("arrow keys move between free times and between days; ? opens the shortcut list but never while typing", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(6, testInfo.repeatEachIndex),
  );
  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await visitor.newPage();
  await page.setViewportSize({ width: 360, height: 800 }); // three columns
  await page.goto(grid(doctorId, day));
  const first = chip(page, slots[0]).getByRole("link");
  await tabTo(page, first);
  await page.keyboard.press("ArrowRight");
  await expect(chip(page, slots[1]).getByRole("link")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(first).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("link", { name: / free, book this time$/ }).last(),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("link", { name: / free, book this time$/ }).nth(3),
  ).toBeFocused();

  const days = page
    .getByRole("navigation", { name: "Pick a day" })
    .locator("a");
  await tabTo(page, days.first());
  await page.keyboard.press("ArrowRight");
  await expect(days.nth(1)).toBeFocused();

  // ? opens the list; Escape closes it; typing a ? into a field does neither.
  await page.locator("body").press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  const date = page.getByLabel("Another date");
  await date.focus();
  await page.keyboard.press("?");
  await expect(help).toHaveCount(0);
  await visitor.close();
});

test("the live-state line says how the grid is being kept current", async ({
  browser,
}, testInfo) => {
  const { doctorId, day } = await farCell(cellOf(7, testInfo.repeatEachIndex));
  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await visitor.newPage();
  await page.goto(grid(doctorId, day));
  await expect(page.locator("[data-polling]")).toHaveAttribute(
    "data-polling",
    "armed",
  );
  await expect(
    page.getByText(
      /Live: times update as they change|Checking for changes every few seconds/,
    ),
  ).toBeVisible();
  await visitor.close();
});

test("a booked visit whose time has passed is read-only", async ({
  browser,
}, testInfo) => {
  const { doctorId, slots } = await farCell(
    cellOf(8, testInfo.repeatEachIndex),
  );
  const me = await signedIn(browser);
  const page = me.page;
  await bookOn(page, doctorId, slots[1]);
  const id = page.url().split("/").pop()!;

  // The API refuses to book a past time, so the booking is made for a future one and then moved back
  // in the database: this one row only, found by its own id, so no other test can see the change.
  const moved = await withDb((db) =>
    db.query(
      `UPDATE appointments
          SET starts_at = starts_at - interval '200 days',
              ends_at = ends_at - interval '200 days'
        WHERE id = $1`,
      [id],
    ),
  );
  expect(moved.rowCount).toBe(1);

  await page.goto(`/appointments/${id}`);
  await expect(
    page.getByRole("heading", { name: "This visit has passed" }),
  ).toBeVisible();
  await expect(
    page.getByText("can no longer be moved or cancelled"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "My appointments" })
      .last(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);

  // The reschedule address says the same instead of offering times.
  await page.goto(`/appointments/${id}/reschedule`);
  await expect(page.getByText(/less than an hour/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);

  await closeAll(me.context);
});

test("a doctor portrait that fails to load falls back to the illustration, then to initials", async ({
  browser,
}) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await context.newPage();
  await page.route("**/doctors/*.webp", (r) => r.abort());
  await page.goto("/book");
  const first = page.locator("li img").first();
  await expect(first).toHaveAttribute("src", /\/doctors\/[0-9a-f-]{36}\.svg$/);
  await expect(first).toHaveAttribute(
    "title",
    "Illustration of a fictional doctor",
  );

  await page.route("**/doctors/*.svg", (r) => r.abort());
  await page.reload();
  await expect(page.locator("li img")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /^Dr\. / }).first()).toBeVisible();
  await context.close();
});

test("the photo disclosure is on the doctor list and in each portrait's description", async ({
  page,
}) => {
  await page.goto("/book");
  await expect(
    page
      .getByRole("main")
      .getByText("AI-generated portraits of fictional doctors."),
  ).toBeVisible();
  const img = page.locator("li img").first();
  await expect(img).toHaveAttribute(
    "title",
    "AI-generated portraits of fictional doctors",
  );
  await expect(img).toHaveAttribute(
    "srcset",
    /-256\.webp 256w, .*-512\.webp 512w$/,
  );
  await expect(img).toHaveAttribute("alt", /^Dr\. /);
  await page.goto("/");
  await expect(
    page.getByRole("contentinfo").getByRole("link", {
      name: /AI-generated portraits of fictional doctors/,
    }),
  ).toHaveAttribute("href", /#doctor-portraits-ai-generated$/);
});

test("a link to a time someone else has taken lands on that day's times with a notice", async ({
  browser,
}, testInfo) => {
  const { doctorId, slots } = await farCell(
    cellOf(9, testInfo.repeatEachIndex),
  );
  const other = await signedIn(browser);
  await bookOn(other.page, doctorId, slots[1]);

  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await visitor.newPage();
  await page.goto(details(doctorId, slots[1]));
  await expect(
    page.getByRole("heading", { name: "Confirm your visit" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "no longer free" }),
  ).toHaveText("That time is no longer free. Pick another time.");
  await expectInactive(page, slots[1], /Booked/);
  await expectFree(page, slots[2]);
  // The notice is spoken as a status, and the free times are still links.
  await expect(
    page.getByRole("link", { name: new RegExp(`^${hhmm(slots[2])} free`) }),
  ).toHaveAttribute("href", details(doctorId, slots[2]));
  await closeAll(other.context, visitor);
});
