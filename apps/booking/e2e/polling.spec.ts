import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { hhmm, pick } from "./api";
import { newPerson, sessionCookies } from "./support/auth";
import { IDLE_MS, POLL_MS } from "../src/lib/polling";

// ADR-0009, patient side, against the real API and database. The 15 s and 10 min waits are real
// timings of the app, so the browser's clock is driven (page.clock) instead of sleeping; every
// request still goes over the real network to the real API. Only the second booker's slot (week 9)
// is written; the other scenarios only read, so none of them can meet another spec's data.

// The proxy rate-limits clients with no forwarded address to a tiny shared bucket, as it does for
// anything not behind the edge. Each context announces its own address, as Vercel's edge would.
let nextIp = 0;
const ip = () =>
  `10.9.${Math.floor(Math.random() * 200)}.${(nextIp++ % 250) + 1}`;

async function context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
}

const isAvailability = (url: string) =>
  url.includes("/api/doctors/") && url.includes("/availability");

// `seen` counts availability requests the browser sent; `answered` counts the replies that came
// back. A reply that lands after the driven clock has jumped would be stamped with the later time,
// so the tests wait for `answered` to catch up before moving the clock again.
const availabilityCalls = (page: Page) => {
  const seen: string[] = [];
  const answered: string[] = [];
  page.on("request", (r) => isAvailability(r.url()) && seen.push(r.url()));
  const done = (r: { url(): string }) =>
    isAvailability(r.url()) && answered.push(r.url());
  page.on("requestfinished", done);
  // A refetch that starts while one is in flight cancels the older one; that request is over too.
  page.on("requestfailed", done);
  return Object.assign(seen, {
    settled: () => expect.poll(() => seen.length - answered.length).toBe(0),
  });
};

async function setVisibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => s,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => s === "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);
}

async function bookAs(browser: Browser, doctorId: string, startsAt: string) {
  const ctx = await context(browser);
  await ctx.addCookies(await sessionCookies(newPerson()));
  const page = await ctx.newPage();
  await page.goto(
    `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`,
  );
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  await ctx.close();
}

test("a time another person books disappears from an open page without a reload", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(9);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.clock.install();
  await page.goto(`/book/${doctorId}?date=${day}`);
  const taken = page.getByText(hhmm(slots[0]), { exact: true });
  const kept = page.getByText(hhmm(slots[3]), { exact: true });
  await expect(taken).toBeVisible();
  // A marker that a reload would wipe: the page must be updated in place.
  await page.evaluate(() => {
    (window as unknown as { __noReload: boolean }).__noReload = true;
  });

  await bookAs(browser, doctorId, slots[0]);

  await page.clock.runFor(POLL_MS + 1000);
  await expect(taken).toHaveCount(0);
  await expect(kept).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload,
    ),
  ).toBe(true);
  await ctx.close();
});

test("a time the person had picked and someone else books says it was just taken", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(9);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.clock.install();
  await page.goto(`/book/${doctorId}?date=${day}`);
  await page.getByText(hhmm(slots[1]), { exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue" })).toBeVisible();

  await bookAs(browser, doctorId, slots[1]);

  await page.clock.runFor(POLL_MS + 1000);
  await expect(page.getByRole("status")).toContainText(
    `${hhmm(slots[1])} was just taken`,
  );
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await ctx.close();
});

test("polling runs while the tab is visible, pauses when hidden and catches up on return", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(10);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.clock.install();
  const calls = availabilityCalls(page);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await expect(page.getByText(hhmm(slots[0]), { exact: true })).toBeVisible();
  expect(calls).toHaveLength(0); // the first answer came from the server render

  await page.clock.runFor(POLL_MS + 500);
  await expect.poll(() => calls.length).toBe(1);
  await calls.settled();

  await setVisibility(page, "hidden");
  const beforeHidden = calls.length;
  await page.clock.runFor(4 * POLL_MS);
  // Hidden for four intervals: nothing was asked of the API.
  expect(calls).toHaveLength(beforeHidden);

  await setVisibility(page, "visible");
  await expect.poll(() => calls.length).toBe(beforeHidden + 1);
  await ctx.close();
});

test("polling stops after ten idle minutes and a click resumes it", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(10);
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await page.clock.install();
  const calls = availabilityCalls(page);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await expect(page.getByText(hhmm(slots[0]), { exact: true })).toBeVisible();

  // No pointer or keyboard input for ten minutes (the clock jumps; intervals fire once).
  await page.clock.fastForward(IDLE_MS + 1000);
  const chip = page.getByRole("button", { name: "Paused, click to refresh" });
  await expect(chip).toBeVisible();
  // The clock jump fired the 15 s interval once, just before the idle timer; let that reply land.
  await calls.settled();

  const settled = calls.length;
  await page.clock.runFor(4 * POLL_MS);
  expect(calls).toHaveLength(settled);

  await chip.click();
  await expect.poll(() => calls.length).toBe(settled + 1);
  await calls.settled();
  await expect(chip).toHaveCount(0);
  await page.clock.runFor(POLL_MS + 500);
  await expect.poll(() => calls.length).toBe(settled + 2);
  await ctx.close();
});
