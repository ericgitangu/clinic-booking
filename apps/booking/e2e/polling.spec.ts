import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { hhmm, pick } from "./api";
import { ownCell } from "./support/cells";
import { newPerson, sessionCookies } from "./support/auth";
import { IDLE_MS, POLL_MS } from "../src/lib/polling";

// Each booking scenario writes one slot. Instance i = repeat * 2 + scenario owns calendar cell i
// (support/cells.ts), so concurrent repeats and workers can never book the same time.
const cellOf = (scenario: number, repeat: number) => repeat * 2 + scenario;

// Patient polling, against the real API and database. The 15 s and 10 min waits are real
// timings of the app, so the browser's clock is driven (page.clock) instead of sleeping; every
// request still goes over the real network to the real API. Only the second booker's slot (week 9)
// is written; the other scenarios only read, so none of them can meet another spec's data.

// The proxy rate-limits clients with no forwarded address to a tiny shared bucket, as it does for
// anything not behind the edge. Each context announces its own address, as Vercel's edge would.
// 10.<worker>.<n / 250>.<n % 250 + 1>: unique per context across workers, so one test using up its
// allowance (the 429 scenario) can never be seen by another test's page.
let nextIp = 0;
const ip = () => {
  const n = nextIp++;
  return `10.${test.info().workerIndex % 256}.${Math.floor(n / 250) % 256}.${(n % 250) + 1}`;
};

async function context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
}

// PW_CPU_THROTTLE=4 slows the page's CPU 4x (Chrome DevTools protocol), as a busy CI runner does.
async function openPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  const rate = Number(process.env.PW_CPU_THROTTLE ?? 1);
  if (rate > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  }
  return page;
}

// The polling hook marks the page once its interval and idle timer are running. Driving the clock
// before that would race hydration: a timer armed after the jump never sees the time that passed.
const polling = (page: Page) =>
  expect(page.locator("[data-polling]")).toHaveAttribute(
    "data-polling",
    "armed",
  );

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
  const page = await openPage(ctx);
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
}, testInfo) => {
  const { doctorId, day, slots } = await ownCell(
    cellOf(0, testInfo.repeatEachIndex),
  );
  const ctx = await context(browser);
  const page = await openPage(ctx);
  await page.clock.install();
  await page.goto(`/book/${doctorId}?date=${day}`);
  await polling(page);
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
}, testInfo) => {
  const { doctorId, day, slots } = await ownCell(
    cellOf(1, testInfo.repeatEachIndex),
  );
  const ctx = await context(browser);
  const page = await openPage(ctx);
  await page.clock.install();
  await page.goto(`/book/${doctorId}?date=${day}`);
  await polling(page);
  await page.getByText(hhmm(slots[1]), { exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue" })).toBeVisible();

  await bookAs(browser, doctorId, slots[1]);

  await page.clock.runFor(POLL_MS + 1000);
  await expect(
    page.getByText(`${hhmm(slots[1])} was just taken`),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await ctx.close();
});

test("polling runs while the tab is visible, pauses when hidden and catches up on return", async ({
  browser,
}) => {
  const { doctorId, day, slots } = await pick(10);
  const ctx = await context(browser);
  const page = await openPage(ctx);
  await page.clock.install();
  const calls = availabilityCalls(page);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await polling(page);
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
  const page = await openPage(ctx);
  await page.clock.install();
  const calls = availabilityCalls(page);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await polling(page);
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

test("a real 429 from the proxy is waited out for its Retry-After, and the page says it could not refresh", async ({
  browser,
}) => {
  const { doctorId, day } = await pick(10);
  const ctx = await context(browser);
  const page = await openPage(ctx);
  await page.clock.install();
  const calls = availabilityCalls(page);
  const replies: { status: number; retryAfter: string | undefined }[] = [];
  page.on("response", (r) => {
    if (isAvailability(r.url()))
      replies.push({
        status: r.status(),
        retryAfter: r.headers()["retry-after"],
      });
  });
  await page.goto(`/book/${doctorId}?date=${day}`);
  await polling(page);

  // The hint container is in the page before anything fails, and empty.
  const hint = page.getByTestId("refresh-hint");
  await expect(hint).toHaveAttribute("role", "status");
  await expect(hint).toHaveAttribute("aria-live", "polite");
  await expect(hint).toHaveText("");

  // Use up this address's allowance at the real proxy (the default is 120 a minute) so that the
  // page's next poll gets the proxy's own 429.
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 120);
  for (let i = 0; i < limit; i++) {
    await ctx.request.get("/api/health");
  }

  await page.clock.runFor(POLL_MS + 500);
  await expect.poll(() => calls.length).toBe(1);
  await calls.settled();
  expect(replies[0].status).toBe(429);
  const retryAfter = Number(replies[0].retryAfter);
  expect(retryAfter).toBeGreaterThan(30); // the window is a minute; the header says how much is left
  await expect(hint).toHaveText(
    "Couldn't refresh. We'll try again automatically.",
  );

  // The backoff alone would poll again after 30 s. Retry-After is the minimum: no request before it
  // (the page clock is driven; each step waits for any request it started to finish).
  const before = await page.evaluate(() => Date.now());
  await page.clock.runFor(retryAfter * 1000 - 3000);
  await calls.settled();
  expect(calls).toHaveLength(1);
  await page.clock.runFor(6000);
  await expect.poll(() => calls.length).toBe(2);
  const after = await page.evaluate(() => Date.now());
  expect(after - before).toBeGreaterThanOrEqual(retryAfter * 1000 - 3000);
  await ctx.close();
});
