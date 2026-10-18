import { expect, test, type Page } from "@playwright/test";
import { newPerson, sessionCookies } from "./support/auth";

// The header follows the session through Better Auth's own hook: real cookies, real app, real
// browser tabs. Only Google's token endpoint is stood in for (support/oauth-flow.ts).

const signOutButton = (page: Page) =>
  page.getByRole("button", { name: "Sign out" });

// The tab comes back to the front: the browser says so and Better Auth looks at the session again.
// Better Auth looks again at most every few seconds, so a tab that keeps coming back is retried
// until the header agrees, as a real person switching tabs would.
async function untilHeader(page: Page, count: 0 | 1) {
  await expect(async () => {
    await focusAgain(page);
    await expect(signOutButton(page)).toHaveCount(count, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

const focusAgain = (page: Page) =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });

test("a signed-in visitor sees their name and Sign out, a visitor sees neither", async ({
  browser,
}) => {
  const person = newPerson();
  const ctx = await browser.newContext();
  const anon = await ctx.newPage();
  await anon.goto("/about");
  await expect(
    anon.getByRole("button", { name: "Display settings" }),
  ).toBeVisible();
  await expect(signOutButton(anon)).toHaveCount(0);
  await ctx.addCookies(await sessionCookies(person));
  await anon.reload();
  await expect(signOutButton(anon)).toBeVisible();
  await ctx.close();
});

test("signing out in one tab signs the other tab's header out", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  await ctx.addCookies(await sessionCookies(newPerson()));
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await a.goto("/about");
  await b.goto("/about");
  await expect(signOutButton(a)).toBeVisible();
  await expect(signOutButton(b)).toBeVisible();
  await signOutButton(b).click();
  await expect(signOutButton(b)).toHaveCount(0);
  await untilHeader(a, 0);
  await ctx.close();
});

test("a session that ends or starts elsewhere shows when the tab comes back", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/about");
  await expect(signOutButton(page)).toHaveCount(0);
  // Signed in somewhere else (another tab or window): the cookies appear in the browser.
  await ctx.addCookies(await sessionCookies(newPerson()));
  await untilHeader(page, 1);
  // Signed out elsewhere: the cookies go.
  await ctx.clearCookies();
  await untilHeader(page, 0);
  await ctx.close();
});
