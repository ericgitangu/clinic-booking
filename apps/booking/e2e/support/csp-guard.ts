import { expect, test as base } from "@playwright/test";

export * from "@playwright/test";

// A page that breaks its own Content-Security-Policy says so in the console ("Refused to ..." or
// "... violates the following Content Security Policy directive"). Every scenario in the suite runs
// with the policy on, and any such message, in any page of any context the scenario opens, fails it.
export const CSP_MESSAGE =
  /Content[- ]Security[- ]Policy|violates the following|Refused to (?:load|connect|execute|apply|frame)/i;

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [
    async ({ browser, context }, use, testInfo) => {
      const hits: string[] = [];
      const watch = (c: import("@playwright/test").BrowserContext) =>
        c.on("console", (m) => {
          if (CSP_MESSAGE.test(m.text())) hits.push(m.text());
        });
      watch(context);
      // Scenarios open their own contexts from `browser`; watch those too.
      const open = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const c = await open(options);
        watch(c);
        return c;
      };
      await use();
      browser.newContext = open;
      // A scenario that breaks the policy on purpose (to prove it blocks) says so with this annotation.
      if (testInfo.annotations.some((a) => a.type === "csp-expected")) return;
      expect(hits, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});
