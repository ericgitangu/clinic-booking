import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The /architecture page is static: these checks need no API. They read the page as served and
// drive the tabs the way a person does, by pointer, by keyboard and by link.

const TABS = [
  "Overview",
  "Decisions record",
  "Operations",
  "Evidence",
  "API and collections",
  "Screenshots",
];
const IDS = [
  "overview",
  "decisions-record",
  "operations",
  "evidence",
  "api",
  "screenshots",
];

test("every tab's content is in the HTML a script-less client receives", async ({
  request,
}) => {
  const html = await (await request.get("/architecture")).text();
  for (const id of [
    ...IDS,
    "adr-0003",
    "adr-0034",
    "neon",
    "bootstrap",
    "base-image-cve",
    "rollback",
    "go-gateway",
    "api-errors",
    "evidence-spend-cap",
    "shot-staff-dashboard",
  ])
    expect(html, id).toContain(`id="${id}"`);
});

test("without JavaScript every panel is readable, one after the other", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/architecture`);
  const panels = page.locator('[role="tabpanel"]');
  await expect(panels).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expect(panels.nth(i)).toBeVisible();
  await context.close();
});

test("is a real tablist: roles, one tab stop, a labelled panel for each", async ({
  page,
}) => {
  await page.goto("/architecture");
  await expect(
    page.getByRole("heading", { level: 1, name: "Architecture" }),
  ).toBeVisible();
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(TABS);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toHaveCount(1); // hidden panels are not exposed
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Overview");
});

test("arrow keys, Home and End move between tabs and wrap", async ({
  page,
}) => {
  await page.goto("/architecture");
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Decisions record" }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Decisions record" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Decisions record" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Screenshots" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Screenshots" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Overview" })).toBeFocused();
  await expect(page).toHaveURL(/#overview$/);
});

test("a tab can be linked by hash or ?tab=", async ({ page }) => {
  await page.goto("/architecture#operations");
  await expect(page.getByRole("tab", { name: "Operations" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto("/architecture?tab=evidence");
  await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a card link opens its tab and the card", async ({ page }) => {
  for (const [hash, tab] of [
    ["adr-0003", "Decisions record"],
    ["rollback", "Operations"],
    ["go-gateway", "Operations"],
    ["neon", "Operations"],
    ["bootstrap", "Operations"],
    ["base-image-cve", "Operations"],
    ["api-errors", "API and collections"],
    ["postman-collection", "API and collections"],
  ] as const) {
    await page.goto(`/architecture#${hash}`);
    await expect(page.getByRole("tab", { name: tab }), hash).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const card = page.locator(`details#${hash}`);
    await expect(card, hash).toHaveAttribute("open", "");
    await expect(card.locator("summary"), hash).toBeInViewport();
  }
});

test("following a link on the page while it is open changes the tab", async ({
  page,
}) => {
  await page.goto("/architecture#adr-0003");
  await expect(
    page.getByRole("tab", { name: "Decisions record" }),
  ).toHaveAttribute("aria-selected", "true"); // the page has hydrated
  await page.evaluate(() => {
    window.location.hash = "evidence-spend-cap";
  });
  await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("details#evidence-spend-cap")).toHaveAttribute(
    "open",
    "",
  );
});

test("the decisions record has a card for every decision with four parts", async ({
  page,
}) => {
  await page.goto("/architecture#decisions-record");
  const cards = page.locator("#decisions-record details");
  await expect(cards).toHaveCount(34);
  await page.getByRole("button", { name: "Open all cards" }).click();
  await expect(page.locator("#decisions-record details[open]")).toHaveCount(34);
  await expect(
    page.locator("#decisions-record dt", { hasText: "What I decided" }),
  ).toHaveCount(34);
  await expect(
    page.locator("#decisions-record dt", { hasText: "What it cost" }),
  ).toHaveCount(34);
  await expect(
    page.locator("#decisions-record dt", {
      hasText: "When I would revisit it",
    }),
  ).toHaveCount(34);
  await page.getByRole("button", { name: "Close all cards" }).click();
  await expect(page.locator("#decisions-record details[open]")).toHaveCount(0);
});

test("the footer's Architecture link reaches the page", async ({ page }) => {
  await page.goto("/about");
  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Architecture", exact: true })
    .click();
  await expect(page).toHaveURL(/\/architecture$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Architecture" }),
  ).toBeVisible();
});

test("is in the sitemap with its own title and canonical", async ({
  page,
  request,
}) => {
  await page.goto("/architecture");
  await expect(page).toHaveTitle(/Architecture \| Idyllic/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/architecture$/,
  );
  expect(await (await request.get("/sitemap.xml")).text()).toContain(
    "/architecture</loc>",
  );
});

test("the strict CSP blocks nothing the page needs", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/architecture#api");
  await expect(
    page.getByRole("tab", { name: "API and collections" }),
  ).toHaveAttribute("aria-selected", "true");
  expect(problems).toEqual([]);
});

for (const width of [360, 768, 1280]) {
  test(`no horizontal scroll at ${width} px on any tab, with every card open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/architecture");
    for (const name of TABS) {
      await page.getByRole("tab", { name }).click();
      await page.getByRole("button", { name: "Open all cards" }).click();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${name} at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious in ${scheme}, on every tab with its cards open`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/architecture");
    for (const name of TABS) {
      await page.getByRole("tab", { name }).click();
      const toggle = page.getByRole("button", { name: "Open all cards" });
      await toggle.click();
      const violations = (await new AxeBuilder({ page }).analyze()).violations;
      expect(
        violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        ),
        `${scheme} ${name}`,
      ).toEqual([]);
    }
  });
}

test("diagrams and screenshots load and have names", async ({ page }) => {
  await page.goto("/architecture");
  const diagrams = page.getByRole("img", { name: /^System context/ });
  await diagrams.scrollIntoViewIfNeeded();
  await expect(diagrams).toBeVisible();
  await page.getByRole("tab", { name: "Screenshots" }).click();
  await page.getByRole("button", { name: "Open all cards" }).click();
  const shot = page.getByRole("img", { name: /staff dashboard/i });
  await shot.scrollIntoViewIfNeeded();
  await expect
    .poll(() => shot.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});
