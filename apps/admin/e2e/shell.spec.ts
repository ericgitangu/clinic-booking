import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, seeded, test } from "./support/fixtures";

// The shared frame (header, way back, footer) on every kind of route, in the real build against the
// real API. Assertions use roles and names, the way a person or a screen reader finds things.

const PHONE = { width: 360, height: 740 };
const DESKTOP = { width: 1280, height: 800 };

type Case = {
  name: string;
  path: () => string;
  // Null on a root page, where no way back is drawn.
  parent: string | null;
  parentName: string | null;
  as?: "owner";
  status?: number;
};

const CASES: Case[] = [
  {
    name: "sign-in gate",
    path: () => "/",
    parent: null,
    parentName: null,
  },
  {
    name: "dashboard",
    path: () => "/dashboard",
    parent: null,
    parentName: null,
    as: "owner",
  },
  {
    name: "access",
    path: () => "/access",
    parent: "/dashboard",
    parentName: "Dashboard",
    as: "owner",
  },
  {
    name: "appointment history",
    path: () => `/dashboard/appointments/${seeded().rescheduled}`,
    parent: "/dashboard",
    parentName: "Dashboard",
    as: "owner",
  },
  {
    name: "404",
    path: () => "/no-such-page",
    parent: "/dashboard",
    parentName: "Dashboard",
    as: "owner",
    status: 404,
  },
  {
    name: "error",
    path: () => "/e2e-shell/error",
    parent: "/dashboard",
    parentName: "Dashboard",
    as: "owner",
    status: 500,
  },
];

const trailOf = (page: Page) =>
  page.getByRole("navigation", { name: "Breadcrumb" });

test.describe("every route has the header, the footer and a way back", () => {
  for (const c of CASES) {
    test(`${c.name}: desktop trail ends in a link to its parent`, async ({
      as,
      page,
    }) => {
      if (c.as) await as(c.as);
      await page.setViewportSize(DESKTOP);
      const res = await page.goto(c.path());
      if (c.status) expect(res?.status(), c.name).toBe(c.status);
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      if (c.parent === null) {
        await expect(trailOf(page)).toHaveCount(0);
        return;
      }
      const link = trailOf(page).getByRole("link", { name: c.parentName! });
      await expect(link).toHaveAttribute("href", c.parent);
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(
        trailOf(page).locator('[aria-current="page"]'),
      ).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${c.parent}$`));
      await expect(page.getByRole("banner")).toBeVisible();
    });

    test(`${c.name}: a phone gets one "Back to" link`, async ({ as, page }) => {
      if (c.as) await as(c.as);
      await page.setViewportSize(PHONE);
      await page.goto(c.path());
      const back = trailOf(page).getByRole("link", { name: /^Back to / });
      if (c.parent === null) {
        await expect(back).toHaveCount(0);
        return;
      }
      await expect(back).toHaveText(`Back to ${c.parentName}`);
      await expect(back).toHaveAttribute("href", c.parent);
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  }
});

test.describe("the header", () => {
  for (const [label, viewport] of [
    ["phone", PHONE],
    ["desktop", { width: 1280, height: 420 }],
  ] as const) {
    test(`stays at the top of the ${label} while the dashboard scrolls`, async ({
      as,
      page,
    }) => {
      await as("owner");
      await page.setViewportSize(viewport);
      await page.goto("/dashboard");
      const header = page.getByRole("banner");
      await expect(header).toBeVisible();
      const y = await page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        return window.scrollY;
      });
      expect(y, "the dashboard must be long enough to scroll").toBeGreaterThan(
        200,
      );
      await expect(header).toBeInViewport({ ratio: 1 });
      expect((await header.boundingBox())!.y).toBe(0);
    });
  }

  test("is 56px tall on a 360px phone and does not move the page when the menu opens", async ({
    as,
    page,
  }) => {
    await as("owner");
    await page.setViewportSize(PHONE);
    await page.goto("/access");
    expect(
      (await page.getByRole("banner").boundingBox())!.height,
    ).toBeLessThanOrEqual(56);
    const title = page.getByRole("heading", { level: 1 });
    const before = (await title.boundingBox())!;
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
    expect(await title.boundingBox()).toEqual(before);
  });

  test("marks where you are with aria-current=page", async ({ as, page }) => {
    await as("owner");
    await page.setViewportSize(DESKTOP);
    await page.goto("/access");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Access" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      nav.getByRole("link", { name: "Dashboard" }),
    ).not.toHaveAttribute("aria-current", "page");
    await page.goto(`/dashboard/appointments/${seeded().rescheduled}`);
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("opens its menu from the keyboard, closes on Escape and returns focus", async ({
    as,
    page,
  }) => {
    await as("owner");
    await page.setViewportSize(PHONE);
    await page.goto("/access");
    const button = page.getByRole("button", { name: "Open menu" });
    await button.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("navigation", { name: "Menu" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("link").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });
});

test.describe("the skip link", () => {
  for (const c of CASES.filter((x) => x.as !== "owner" || x.status)) {
    test(`is the first stop on ${c.name} and moves focus to the content`, async ({
      as,
      page,
    }) => {
      if (c.as) await as(c.as);
      await page.setViewportSize(DESKTOP);
      await page.goto(c.path());
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Skip to content" });
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
    });
  }
});

test.describe("accessibility of the frame", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${scheme} theme`, () => {
      test.use({ colorScheme: scheme });
      for (const c of CASES) {
        for (const [label, viewport] of [
          ["desktop", DESKTOP],
          ["phone", PHONE],
        ] as const) {
          test(`${c.name} on ${label} has no serious findings`, async ({
            as,
            page,
          }) => {
            if (c.as) await as(c.as);
            await page.setViewportSize(viewport);
            await page.goto(c.path());
            await expect(page.getByRole("banner")).toBeVisible();
            const { violations } = await new AxeBuilder({ page }).analyze();
            expect(
              violations
                .filter(
                  (v) => v.impact === "serious" || v.impact === "critical",
                )
                .map(
                  (v) =>
                    `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
                ),
            ).toEqual([]);
          });
        }
      }

      test("the open phone menu has none either", async ({ as, page }) => {
        await as("owner");
        await page.setViewportSize(PHONE);
        await page.goto("/access");
        await page.getByRole("button", { name: "Open menu" }).click();
        await expect(
          page.getByRole("navigation", { name: "Menu" }),
        ).toBeVisible();
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(
          violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => v.id),
        ).toEqual([]);
      });
    });
  }
});

test.describe("signed out, and the 404", () => {
  test("the header offers Sign in, not a Dashboard that only leads back to it", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
  });

  test("the 404 has a way to the dashboard and to the patient site", async ({
    as,
    page,
  }) => {
    await as("owner");
    await page.setViewportSize(DESKTOP);
    const res = await page.goto("/no-such-page");
    expect(res?.status()).toBe(404);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(
      "We could not find that page",
    );
    await expect(
      main.getByRole("link", { name: "Back to dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
    await expect(
      main.getByRole("link", { name: "Patient site" }),
    ).toHaveAttribute("href", /^https:\/\/clinic\./);
  });

  test("a short page keeps the footer at the bottom of a tall window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1500 });
    await page.goto("/");
    const footer = (await page.getByRole("contentinfo").boundingBox())!;
    expect(footer.y + footer.height).toBeGreaterThanOrEqual(1499);
    // Same structure as the patient site: four columns under the content.
    await expect(
      page.getByRole("contentinfo").getByRole("navigation"),
    ).toHaveCount(4);
  });
});
