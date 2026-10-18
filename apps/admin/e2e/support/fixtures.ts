import {
  expect,
  test as base,
  type BrowserContext,
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

// A page that breaks its own Content-Security-Policy says so in the console. Every scenario runs with
// the policy on, and any such message, in any page of the scenario's context, fails it.
const CSP_MESSAGE =
  /Content[- ]Security[- ]Policy|violates the following|Refused to (?:load|connect|execute|apply|frame)/i;

export const test = base.extend<{
  as: (who: Persona | string) => Promise<Page>;
  cspGuard: void;
}>({
  cspGuard: [
    async ({ context }, use, testInfo) => {
      const hits: string[] = [];
      context.on("console", (m) => {
        if (CSP_MESSAGE.test(m.text())) hits.push(m.text());
      });
      await use();
      // A scenario that breaks the policy on purpose (to prove it blocks) says so with this annotation.
      if (testInfo.annotations.some((a) => a.type === "csp-expected")) return;
      expect(hits, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  page: async ({ page, context }, use) => {
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
