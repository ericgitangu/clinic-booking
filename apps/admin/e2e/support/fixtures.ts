import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { EMAIL, type Persona } from "./stack";
import { sessionCookies } from "./test-auth";

export interface Seeded {
  doctorId: string;
  rescheduled: string;
  cancelled: string;
  free: string[];
}

export function seeded(): Seeded {
  const raw = process.env.E2E_STATE;
  if (!raw) throw new Error("global setup did not run");
  return JSON.parse(raw) as Seeded;
}

/** Signs a browser context in as the given person, with cookies Better Auth itself produced. */
export async function signIn(context: BrowserContext, email: string) {
  await context.addCookies(await sessionCookies(email));
}

// ADMIN_E2E_CPU_THROTTLE=4 slows the browser's CPU four times (Chrome DevTools Protocol), to model
// a slow CI runner. Unset, nothing changes.
const THROTTLE = Number(process.env.ADMIN_E2E_CPU_THROTTLE ?? 1);

export const test = base.extend<{
  as: (who: Persona | string) => Promise<Page>;
}>({
  page: async ({ page, context }, use) => {
    // The pages stream in and hydrate after the load event, and a click before that does nothing.
    // (Not "networkidle": the live feed keeps a stream open for as long as a page is.) After a
    // navigation, wait until React has attached to the first buttons and links, best effort.
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const res = await goto(url, options);
      await page
        .waitForFunction(
          () => {
            const els = [...document.querySelectorAll("button, a")].slice(0, 6);
            return (
              els.length === 0 ||
              els.some((el) =>
                Object.keys(el).some((k) => k.startsWith("__reactProps")),
              )
            );
          },
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      return res;
    };
    if (THROTTLE > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    }
    await use(page);
  },
  as: async ({ page }, use) => {
    await use(async (who) => {
      const email = who in EMAIL ? EMAIL[who as Persona] : who;
      await signIn(page.context(), email);
      return page;
    });
  },
});

export { expect } from "@playwright/test";

/**
 * Clicks a control once React has attached to it. The pages are server-rendered and stream in, so a
 * click that lands before hydration does nothing and the test would wait for an outcome that never
 * comes. React marks every hydrated element with an internal props key; wait for it.
 */
export async function tap(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((el) =>
        Object.keys(el).some((k) => k.startsWith("__reactProps")),
      ),
    )
    .toBe(true);
  await locator.click();
}

/**
 * Waits for the real condition before a colour scan, not for a pause: the page is in the theme the
 * browser asked for (the class on <html> matches prefers-color-scheme), the fonts are in, nothing
 * is animating or transitioning, and two frames have passed, so axe reads colours as they rest and
 * never half way through a change of theme or a fade.
 */
export async function settle(page: Page): Promise<void> {
  const dark = await page.evaluate(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  await expect(page.locator("html")).toHaveClass(
    new RegExp(`\\b${dark ? "dark" : "light"}\\b`),
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
