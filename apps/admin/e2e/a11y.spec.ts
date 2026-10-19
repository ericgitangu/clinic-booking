// Signed-in accessibility check: axe-core on the pages Lighthouse cannot reach. The
// session is a real Better Auth session made through its real OAuth callback (see
// support/oauth-flow.ts: only Google's token endpoint is stood in for), and the pages are the
// production build, reading the real API. Serious and critical findings fail the test; the
// findings are printed in full so a failure says which element and which rule.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, seeded, tap, test } from "./support/fixtures";

const SCHEMES = ["light", "dark"] as const;

async function audit(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags([
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22aa",
      "best-practice",
    ])
    .analyze();
  return violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

// axe reads colours as drawn at that instant; a dialog still fading in is half transparent.
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
}

function report(violations: Awaited<ReturnType<typeof audit>>): string {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes
          .map((n) => `  ${n.target.join(" ")}\n    ${n.failureSummary}`)
          .join("\n"),
    )
    .join("\n");
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test("the dashboard has no serious or critical violations", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/dashboard");
      await expect(page.getByTestId("kpi-upcoming-booked")).toHaveText(/^\d+$/);
      await expect(
        page.getByRole("img", { name: /Line chart of bookings/ }),
      ).toBeVisible();
      expect(report(await audit(page))).toBe("");
    });

    test("the dashboard on a phone has none either", async ({ as }) => {
      const page = await as("owner");
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto("/dashboard");
      await expect(page.getByTestId("appointments-cards")).toBeVisible();
      expect(report(await audit(page))).toBe("");
    });

    test("the search dialog and the shortcut list have none either", async ({
      as,
    }) => {
      const page = await as("owner");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/dashboard");
      await page.keyboard.press("/");
      await expect(page.getByRole("combobox")).toBeFocused();
      await settled(page);
      expect(report(await audit(page))).toBe("");
      await page.keyboard.press("Escape");
      await page.keyboard.press("?");
      await expect(page.getByRole("dialog")).toContainText(
        "Go to the dashboard",
      );
      await settled(page);
      expect(report(await audit(page))).toBe("");
    });

    test("the book-on-behalf dialog has none either", async ({ as }) => {
      const page = await as("admin");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/dashboard");
      // The page streams in behind its loading skeleton; wait for the real content first.
      await expect(page.getByTestId("today-board")).toBeVisible();
      const open = page.getByRole("button", { name: "Book on behalf" }).first();
      test.skip((await open.count()) === 0, "no free slot at this time of day");
      // A click before the page has hydrated does nothing, so click until the dialog is there.
      await expect(async () => {
        await open.click();
        await expect(page.getByRole("dialog")).toContainText(
          "Book for a patient",
          { timeout: 2000 },
        );
      }).toPass({ timeout: 15_000 });
      await settled(page);
      expect(report(await audit(page))).toBe("");
    });

    test("a drill-down sheet has none either, on a desktop and on a phone", async ({
      as,
    }) => {
      const page = await as("owner");
      for (const size of [
        { width: 1280, height: 900 },
        { width: 360, height: 780 },
      ]) {
        await page.setViewportSize(size);
        await page.goto("/dashboard");
        await expect(page.getByTestId("today-board")).toBeVisible();
        await tap(page.getByRole("button", { name: /^Fill rate\b/ }));
        await expect(page.getByRole("dialog")).toBeVisible();
        await expect(page.getByTestId("drill-count")).toHaveAttribute(
          "data-count",
          /\d+/,
        );
        await settled(page);
        expect(report(await audit(page))).toBe("");
      }
    });

    test("an appointment's page, with its history and actions, has none", async ({
      as,
    }) => {
      const page = await as("admin");
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/dashboard/appointments/${seeded().rescheduled}`);
      await expect(page.getByTestId("lineage")).toBeVisible();
      expect(report(await audit(page))).toBe("");
    });
  });
}
