import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The page renders from src/content/decisions.ts; these checks read the page, not the file.
// The decisions page is static: no API call is needed, so these run without the stack's data.

test("renders every decision with its four parts", async ({ page }) => {
  await page.goto("/decisions");
  await expect(
    page.getByRole("heading", { level: 1, name: "Architecture decisions" }),
  ).toBeVisible();
  const entries = page.locator("article");
  const count = await entries.count();
  expect(count).toBeGreaterThanOrEqual(8);
  expect(count).toBeLessThanOrEqual(10);
  await expect(
    page.getByRole("main").getByRole("heading", { level: 2 }),
  ).toHaveCount(count);

  // Every entry shows four labelled parts.
  const withParts = page.locator("article:has(dl)");
  const written = await withParts.count();
  expect(written).toBe(count);
  for (let i = 0; i < written; i++) {
    const labels = await withParts.nth(i).locator("dt").allInnerTexts();
    expect(labels).toEqual([
      "What I chose",
      "What I gave up",
      "Why",
      "When I would revisit it",
    ]);
  }
  await expect(
    page.getByText("Decision pending engineer sign-off", { exact: true }),
  ).toHaveCount(0);
});

test("says why Go is there and uses no status words", async ({ page }) => {
  await page.goto("/decisions");
  const text = (await page.locator("main").innerText()).toLowerCase();
  for (const word of ["descoped", "superseded", "never built"]) {
    expect(text, word).not.toContain(word);
  }
  expect(text).not.toMatch(/[–—]/);
});

test("the landing page links to the Go entry, which exists", async ({
  page,
}) => {
  await page.goto("/");
  const link = page.getByRole("link", {
    name: "Why a Go service sits next to the FastAPI one",
  });
  await expect(link).toHaveAttribute("href", "/decisions#go");
  await link.click();
  await expect(page).toHaveURL(/\/decisions#go$/);
  await expect(
    page.locator("article#go").getByRole("heading", { level: 2 }),
  ).toHaveText("A small Go service for the staff live feed");
});

test("shows no draft banner once the copy is published", async ({ page }) => {
  await page.goto("/decisions");
  await expect(page.getByTestId("draft-banner")).toHaveCount(0);
});

test("the header and the footer both reach /decisions", async ({ page }) => {
  await page.goto("/about");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Decisions" })
    .click();
  await expect(page).toHaveURL(/\/decisions$/);

  await page.goto("/about");
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Architecture decisions" })
    .click();
  await expect(page).toHaveURL(/\/decisions$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Architecture decisions" }),
  ).toBeVisible();
});

test("the footer sends decision readers to this page, not into the repo tree", async ({
  page,
}) => {
  await page.goto("/decisions");
  await expect(page.locator('footer a[href*="/tree/main/docs"]')).toHaveCount(
    0,
  );
});

test("is in the sitemap and carries its own title and canonical", async ({
  page,
  request,
}) => {
  await page.goto("/decisions");
  await expect(page).toHaveTitle(/Architecture decisions \| Idyllic/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/decisions$/,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    /Architecture decisions/,
  );
  const map = await request.get("/sitemap.xml");
  expect(await map.text()).toContain("/decisions</loc>");
});

for (const width of [360, 768, 1280]) {
  test(`no horizontal scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/decisions");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/decisions");
    await expect(page.locator("article").first()).toBeVisible();
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(
      violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      ),
      `${scheme}`,
    ).toEqual([]);
  });
}

test("the trail reads Home, then Decisions, not Page not found", async ({
  page,
}) => {
  await page.goto("/decisions");
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail.getByRole("link", { name: "Home" })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Decisions");
  await expect(trail.getByText("Page not found")).toHaveCount(0);
});
