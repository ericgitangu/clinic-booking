import { test as base, type BrowserContext, type Page } from "@playwright/test";
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

export const test = base.extend<{
  as: (who: Persona | string) => Promise<Page>;
}>({
  as: async ({ page }, use) => {
    await use(async (who) => {
      const email = who in EMAIL ? EMAIL[who as Persona] : who;
      await signIn(page.context(), email);
      return page;
    });
  },
});

export { expect } from "@playwright/test";
