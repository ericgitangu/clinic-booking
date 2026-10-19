import { expect, test, type Page } from "@playwright/test";
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
