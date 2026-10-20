import { expect, test, type Page } from "./support/csp-guard";
import { newPerson, sessionCookies } from "./support/auth";

// Better Auth rate-limits per client address (100 requests in 10 s by default) and every context
// without an address shares one bucket, so under parallel workers the sign-out call could be refused.
// Each context announces its own address, as the edge would.
let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 50) + 200}.${(nextIp++ % 250) + 1}`;

// The header follows the session through Better Auth's own hook: real cookies, real app, real
// browser tabs. Only Google's token endpoint is stood in for (support/oauth-flow.ts).

const trigger = (page: Page) =>
  page.getByRole("button", { name: /^Account menu for / });

async function signOut(page: Page) {
  await trigger(page).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}

// The tab comes back to the front: the browser says so and Better Auth looks at the session again.
// Better Auth looks again at most every few seconds, so a tab that keeps coming back is retried
// until the header agrees, as a real person switching tabs would.
async function untilHeader(page: Page, count: 0 | 1) {
  await expect(async () => {
    await focusAgain(page);
    await expect(trigger(page)).toHaveCount(count, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

const focusAgain = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });

test("a signed-in visitor sees their account menu, a visitor does not", async ({
  browser,
}) => {
  const person = newPerson();
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const anon = await ctx.newPage();
  await anon.goto("/about");
  await expect(
    anon.getByRole("button", { name: "Display settings" }),
  ).toBeVisible();
  await expect(trigger(anon)).toHaveCount(0);
  await ctx.addCookies(await sessionCookies(person));
  await anon.reload();
  await expect(
    anon.getByRole("button", { name: `Account menu for ${person.name}` }),
  ).toBeVisible();
  await ctx.close();
});

// What a page really downloads: the text of every script the browser fetched, by URL.
async function scriptsLoadedBy(page: Page, open: () => Promise<void>) {
  const bodies: { url: string; text: string }[] = [];
  const reading: Promise<void>[] = [];
  page.on("response", (res) => {
    if (res.request().resourceType() !== "script") return;
    reading.push(
      res.text().then(
        (text) => void bodies.push({ url: res.url(), text }),
        () => undefined, // a response that went away with a navigation has nothing to read
      ),
    );
  });
  await open();
  await Promise.all(reading);
  return bodies;
}

// The code of the account menu (its label is unique to it) and of the toaster (sonner's container).
const ACCOUNT_MENU_CODE = "Account menu for";
const TOASTER_CODE = "data-sonner-toaster";

test("a signed-out visit to /about downloads no account-menu or toaster code; a signed-in one downloads the menu", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const anon = await ctx.newPage();
  const seen = await scriptsLoadedBy(anon, async () => {
    await anon.goto("/about");
    await expect(
      anon.getByRole("button", { name: "Display settings" }),
    ).toBeVisible();
    // Past the idle callback that asks the server for the session, and the network settling after it.
    await anon.waitForLoadState("networkidle");
  });
  expect(seen.length, "the page loaded scripts").toBeGreaterThan(0);
  expect(
    seen.filter((s) => s.text.includes(ACCOUNT_MENU_CODE)).map((s) => s.url),
    "scripts holding the account menu",
  ).toEqual([]);
  expect(
    seen.filter((s) => s.text.includes(TOASTER_CODE)).map((s) => s.url),
    "scripts holding the toaster",
  ).toEqual([]);

  // The same check must be able to fail: with a session the menu's chunk does arrive.
  await ctx.addCookies(await sessionCookies(newPerson()));
  const signedIn = await ctx.newPage();
  const withSession = await scriptsLoadedBy(signedIn, async () => {
    await signedIn.goto("/about");
    await expect(trigger(signedIn)).toBeVisible();
  });
  expect(
    withSession.filter((s) => s.text.includes(ACCOUNT_MENU_CODE)).length,
  ).toBeGreaterThan(0);
  await ctx.close();
});

test("signing out in one tab signs the other tab's header out", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  await ctx.addCookies(await sessionCookies(newPerson()));
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await a.goto("/about");
  await b.goto("/about");
  await expect(trigger(a)).toBeVisible();
  await expect(trigger(b)).toBeVisible();
  await signOut(b);
  await expect(trigger(b)).toHaveCount(0);
  await untilHeader(a, 0);
  await ctx.close();
});

test("a session that ends or starts elsewhere shows when the tab comes back", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": ip() },
  });
  const page = await ctx.newPage();
  await page.goto("/about");
  await expect(trigger(page)).toHaveCount(0);
  // Signed in somewhere else (another tab or window): the cookies appear in the browser.
  await ctx.addCookies(await sessionCookies(newPerson()));
  await untilHeader(page, 1);
  // Signed out elsewhere: the cookies go.
  await ctx.clearCookies();
  await untilHeader(page, 0);
  await ctx.close();
});
