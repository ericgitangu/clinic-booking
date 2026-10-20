import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The tabs on /decisions. The page is static: these checks need no API. The first tab is
// server-rendered; the others are static fragments at /decisions/panel/<id>, loaded when opened.

const TABS = [
  "Decisions",
  "Decision record",
  "Architecture",
  "Operations",
  "Evidence",
  "API and collections",
  "Screenshots",
];
const LAZY = [
  "record",
  "architecture",
  "operations",
  "evidence",
  "api",
  "screenshots",
];

test("the first load carries the ten decisions and no other tab's cards", async ({
  request,
}) => {
  const html = await (await request.get("/decisions")).text();
  expect(html).toContain('id="double-booking"');
  expect(html).not.toContain('id="adr-0003"');
  expect(html).not.toContain('id="rollback"');
});

test("each other tab is a static fragment, and a plain page without scripts", async ({
  request,
}) => {
  for (const [id, anchor] of [
    ["record", "adr-0034"],
    ["architecture", "containers"],
    ["operations", "go-gateway"],
    ["evidence", "evidence-spend-cap"],
    ["api", "api-collection"],
    ["screenshots", "shot-staff-dashboard"],
  ] as const) {
    const res = await request.get(`/decisions/panel/${id}`);
    expect(res.status(), id).toBe(200);
    expect(await res.text(), id).toContain(`id="${anchor}"`);
  }
  expect((await request.get("/decisions/panel/nope")).status()).toBe(404);
});

test("without JavaScript the tabs link to plain pages", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/decisions`);
  for (const t of TABS.slice(1))
    await expect(
      page.getByRole("link", { name: `Read the ${t} tab as a plain page` }),
    ).toBeVisible();
  await expect(page.locator("article#double-booking")).toBeVisible();
  await context.close();
});

test("is a real tablist: roles, one tab stop, a labelled panel", async ({
  page,
}) => {
  await page.goto("/decisions");
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(TABS);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toHaveAccessibleName("Decisions");
});

test("arrow keys, Home and End move between tabs and wrap", async ({
  page,
}) => {
  await page.goto("/decisions");
  await page.getByRole("tab", { name: "Decisions", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const record = page.getByRole("tab", { name: "Decision record" });
  await expect(record).toBeFocused();
  await expect(record).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Decision record" }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Screenshots" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Decisions", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Screenshots" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(/#decisions$/);
});

test("a tab can be linked by hash or ?tab=", async ({ page }) => {
  await page.goto("/decisions#operations");
  await expect(page.getByRole("tab", { name: "Operations" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goto("/decisions?tab=evidence");
  await expect(page.getByRole("tab", { name: "Evidence" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a card link opens its tab, loads it, opens the card and scrolls to it", async ({
  page,
}) => {
  for (const [hash, tab] of [
    ["adr-0001", "Decision record"],
    ["adr-0034", "Decision record"],
    ["rollback", "Operations"],
    ["go-gateway", "Operations"],
    ["neon", "Operations"],
    ["bootstrap", "Operations"],
    ["base-image-cve", "Operations"],
    ["api-errors", "API and collections"],
    ["api-collection", "API and collections"],
    ["containers", "Architecture"],
  ] as const) {
    await page.goto(`/decisions#${hash}`);
    await expect(page.getByRole("tab", { name: tab }), hash).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const card = page.locator(`details#${hash}`);
    await expect(card, hash).toHaveAttribute("open", "");
    await expect(card.locator("summary"), hash).toBeInViewport();
  }
});

test("the ten decisions keep their anchors and select the first tab", async ({
  page,
}) => {
  for (const id of [
    "double-booking",
    "go",
    "hosting-and-cost",
    "one-api",
    "one-hour-rule",
    "polling-then-push",
    "rest-and-errors",
    "thin-web-layer",
    "time",
    "veto-and-lock",
  ]) {
    await page.goto(`/decisions#${id}`);
    await expect(
      page.getByRole("tab", { name: "Decisions", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`article#${id}`)).toBeInViewport();
  }
});

test("following a link while the page is open changes the tab", async ({
  page,
}) => {
  await page.goto("/decisions#adr-0003");
  await expect(
    page.getByRole("tab", { name: "Decision record" }),
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

test("the decision record has a card for every decision with four parts", async ({
  page,
}) => {
  await page.goto("/decisions#record");
  const cards = page.locator("#record details");
  await expect(cards).toHaveCount(34);
  await page.getByRole("button", { name: "Open all cards" }).click();
  await expect(page.locator("#record details[open]")).toHaveCount(34);
  for (const label of [
    "What I decided",
    "What it cost",
    "When I would revisit it",
  ])
    await expect(page.locator("#record dt", { hasText: label })).toHaveCount(
      34,
    );
  await page.getByRole("button", { name: "Close all cards" }).click();
  await expect(page.locator("#record details[open]")).toHaveCount(0);
});

test("a tab that fails to load says so and links to the plain page", async ({
  page,
}) => {
  await page.route("**/decisions/panel/operations", (r) => r.abort());
  await page.goto("/decisions");
  await page.getByRole("tab", { name: "Operations" }).click();
  await expect(page.getByText("This tab did not load.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open it as a plain page" }),
  ).toHaveAttribute("href", "/decisions/panel/operations");
});

test("the footer has the API collection link, with an icon, and it works", async ({
  page,
}) => {
  await page.goto("/about");
  const link = page
    .getByRole("contentinfo")
    .getByRole("link", { name: "API collection (Newman)" });
  await expect(link).toHaveAttribute("href", "/decisions#api-collection");
  await expect(link.locator("svg").first()).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/decisions#api-collection$/);
  await expect(page.locator("details#api-collection")).toHaveAttribute(
    "open",
    "",
  );
});

test("the strict CSP blocks nothing the tabs need", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto("/decisions#api");
  await expect(
    page.getByRole("tab", { name: "API and collections" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("details#api-errors")).toBeAttached();
  expect(problems).toEqual([]);
});

for (const width of [360, 768, 1280]) {
  test(`no horizontal scroll at ${width} px on any tab, with every card open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/decisions");
    for (const name of TABS) {
      await page.getByRole("tab", { name, exact: true }).click();
      if (name !== "Decisions") {
        await expect(page.locator("details[data-card]").first()).toBeAttached();
        await page.getByRole("button", { name: "Open all cards" }).click();
      }
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
    await page.goto("/decisions");
    for (const name of TABS) {
      await page.getByRole("tab", { name, exact: true }).click();
      if (name !== "Decisions") {
        await expect(
          page
            .locator(`#${LAZY[TABS.indexOf(name) - 1]!} details[data-card]`)
            .first(),
        ).toBeAttached();
        await page.getByRole("button", { name: "Open all cards" }).click();
      }
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
  await page.goto("/decisions#architecture");
  const diagram = page.getByRole("img", { name: /^System context/ });
  await diagram.scrollIntoViewIfNeeded();
  await expect(diagram).toBeVisible();
  await page.getByRole("tab", { name: "Screenshots" }).click();
  const shot = page.getByRole("img", { name: /staff dashboard/i });
  await shot.scrollIntoViewIfNeeded();
  await expect
    .poll(() => shot.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBeGreaterThan(0);
});
