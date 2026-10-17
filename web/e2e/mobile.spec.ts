import { expect, test } from "@playwright/test";

// Mobile first: the smallest phone we design for, then a tablet and a desktop.
const VIEWPORTS = [
  { name: "360", width: 360, height: 740 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 900 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name}px wide`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.width < 768,
    });

    test("the landing page never scrolls sideways", async ({ page }) => {
      await page.goto("/");
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });

    test("the home page shows the exact name the OAuth consent screen uses", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page).toHaveTitle("Idyllic Clinic Booking");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Idyllic Clinic Booking",
      );
      await expect(page.getByRole("banner")).toContainText(
        "Idyllic Clinic Booking",
      );
    });

    test("every button and link can be hit with a thumb (at least 44px tall)", async ({
      page,
    }) => {
      await page.goto("/");
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("a, button")]
          .filter(
            (el) =>
              el.offsetParent !== null && !el.classList.contains("sr-only"),
          )
          .map((el) => ({
            label: (el.getAttribute("aria-label") ?? el.textContent ?? "")
              .trim()
              .slice(0, 30),
            height: Math.round(el.getBoundingClientRect().height),
          }))
          .filter((t) => t.height < 44),
      );
      expect(small).toEqual([]);
    });
  });
}

test("the phone menu opens and lists the pages", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "OpenAPI contract" }),
  ).toBeVisible();
});
