// Signed-in accessibility check: axe-core on the pages Lighthouse cannot reach. The
// session is a real Better Auth session made through its real OAuth callback (see
// support/oauth-flow.ts: only Google's token endpoint is stood in for), and the pages are the
// production build, reading the real API. Serious and critical findings fail the test; the
// findings are printed in full so a failure says which element and which rule.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, seeded, test } from "./support/fixtures";

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
