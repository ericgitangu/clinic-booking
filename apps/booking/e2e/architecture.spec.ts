import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The architecture section on the landing page: below the fold, no Mermaid in the browser, an
// accessible diagram with a text alternative, and the right rendering for each colour scheme.

test("the architecture section is below the fold and ships no Mermaid", async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "script") scripts.push(r.url());
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  const top = await page
    .getByRole("heading", { name: "Architecture", level: 2 })
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  expect(top).toBeGreaterThan(720);
  expect(scripts.filter((u) => /mermaid/i.test(u))).toEqual([]);
});

test("the diagram has a label, a table as its text alternative, and loads", async ({
  page,
}) => {
  await page.goto("/");
  const figure = page.getByRole("img", { name: /^Architecture diagram\./ });
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toBeVisible();
  const rows = page
    .getByRole("table", { name: /Each component in the diagram/ })
    .getByRole("row");
  await expect(rows).toHaveCount(15); // the header and 14 components
  await expect(
    page.getByText("reversed that on 2026-10-19", { exact: false }).first(),
  ).toBeVisible();
  // Lazy-loaded below the fold, so wait for it rather than read it once.
  await expect
    .poll(() =>
      page
        .locator('img[src="/architecture-light.svg"]')
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    )
    .toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the ${scheme} rendering is the visible one, and axe finds nothing serious`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto("/");
    const section = page.locator("#architecture").locator("xpath=..");
    await section.scrollIntoViewIfNeeded();
    const visible = scheme === "light" ? "light" : "dark";
    const hidden = scheme === "light" ? "dark" : "light";
    await expect(
      page.locator(`img[src="/architecture-${visible}.svg"]`),
    ).toBeVisible();
    await expect(
      page.locator(`img[src="/architecture-${hidden}.svg"]`),
    ).toBeHidden();
    const serious = (
      await new AxeBuilder({ page }).include("#architecture").analyze()
    ).violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
    await context.close();
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`on a phone (${scheme}) the diagram scrolls inside its box at a readable size`, async ({
    browser,
  }, info) => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 740 },
      colorScheme: scheme,
    });
    const page = await context.newPage();
    await page.goto("/");
    const section = page.locator("#architecture").locator("xpath=..");
    await section.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // The SVG's own text is 18px; on a phone it keeps its natural 1647px width, so it stays 18px.
    const img = page.locator(`img[src="/architecture-${scheme}.svg"]`);
    await expect(img).toBeVisible();
    expect((await img.boundingBox())!.width).toBeGreaterThanOrEqual(1640);
    if (process.env.ARCH_SHOTS) {
      await section.screenshot({
        path: `${process.env.ARCH_SHOTS}/landing-360-${scheme}.png`,
      });
      await page
        .getByRole("img", { name: /^Architecture diagram\./ })
        .screenshot({
          path: `${process.env.ARCH_SHOTS}/diagram-360-${scheme}.png`,
        });
    }
    info.annotations.push({ type: "scheme", description: scheme });
    await context.close();
  });
}

test("at 360 px the landing's command blocks are focusable, named regions and axe finds nothing serious", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
  });
  const page = await context.newPage();
  await page.goto("/");
  const blocks = page.getByRole("region", { name: /^Command to copy: / });
  expect(await blocks.count()).toBeGreaterThanOrEqual(3);
  for (const b of await blocks.all()) {
    await expect(b).toHaveAttribute("tabindex", "0");
  }
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "AI reflection (README \u00a711)" }),
  ).toBeVisible();
  await context.close();
});
