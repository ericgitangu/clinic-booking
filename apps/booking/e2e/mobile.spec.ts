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
      await expect(page).toHaveTitle("Idyllic Clinic");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Idyllic Clinic",
      );
      await expect(page.getByRole("banner")).toContainText("Idyllic Clinic");
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

const HANDLER_PATHS = ["/docs", "/redoc", "/openapi.json"];

test.describe("footer", () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test("fits a 360px screen without sideways scroll", async ({ page }) => {
    await page.goto("/about");
    await page.locator("footer").scrollIntoViewIfNeeded();
    const { scroll, inner } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(inner);
  });

  test("every footer link resolves or is a well-formed external URL", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const links = await page.locator("footer a").evaluateAll((as) =>
      as.map((a) => ({
        href: a.getAttribute("href") ?? "",
        rel: a.getAttribute("rel") ?? "",
      })),
    );
    expect(links.length).toBeGreaterThan(15);
    for (const { href, rel } of links) {
      if (href.startsWith("/")) {
        // The docs routes proxy to the API, which only the deployed site can reach.
        if (HANDLER_PATHS.includes(href)) continue;
        expect((await request.get(href)).status(), href).toBe(200);
      } else {
        const url = new URL(href);
        if (process.env.E2E_CHECK_EXTERNAL === "1") {
          const res = await request.get(href);
          expect(res.status(), href).toBeLessThan(400);
        }
        expect(url.protocol, href).toBe("https:");
        expect(rel, href).toContain("noopener");
        expect(rel, href).toContain("noreferrer");
      }
    }
  });
});
