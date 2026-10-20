// Live notifications against the real stack (docker compose, profile "realtime"): a toast for an
// event that arrives after the page loaded, an unread count on the feed heading while the panel is
// out of view, and the same toast passing axe in both themes. Two tabs of one browser context share
// one stream (src/lib/live-share.ts), so this opens no second slot on the gateway.
import AxeBuilder from "@axe-core/playwright";
import { inFirstHourOfClinicDay, moveToPastHalfHour } from "./support/clock";
import { book, patientReschedules } from "./support/live-book";
import { EMAIL } from "./support/stack";
import { expect, settle, signIn, tap, test } from "./support/fixtures";

const SCHEMES = ["light", "dark"] as const;

test.describe("live notifications", () => {
  test("an arrival marked by someone else shows as a toast and an unread count within 2 seconds", async ({
    as,
    browser,
  }) => {
    test.setTimeout(60_000);
    test.skip(
      inFirstHourOfClinicDay(),
      "a past half hour falls on yesterday in the first hour of the clinic day",
    );
    const made = await book(`Toast Arrival ${Date.now()}`);
    moveToPastHalfHour(made.id, 1);

    // Tab B: the dashboard, with the feed panel below the fold so the count has something to say.
    const tabB = await as("owner");
    await tabB.setViewportSize({ width: 1280, height: 480 });
    await tabB.goto("/dashboard");
    await expect(tabB.getByTestId("live-status")).toHaveAttribute(
      "data-status",
      "live",
    );
    await expect(tabB.getByTestId("live-unread")).toHaveText("");

    // The admin marks it on the appointment page, in a browser of their own. (The local gateway
    // serves one stream, which the owner's page holds, so the admin's page opens none.) The
    // toast is for what someone ELSE did: a change the signed-in person makes is theirs.
    const adminContext = await browser.newContext();
    await adminContext.route("**/live/stream**", (route) => route.abort());
    await signIn(adminContext, EMAIL.admin);
    const tabA = await adminContext.newPage();
    await tabA.goto(`/dashboard/appointments/${made.id}`);
    await tap(tabA.getByRole("button", { name: "Mark arrived" }));
    const ask = tabA.getByRole("dialog", { name: "Mark as arrived?" });
    await ask.getByLabel("Reason").fill("patient is at the desk");
    await ask.getByRole("button", { name: "Mark arrived" }).click();

    const toast = tabB
      .locator("[data-sonner-toast]")
      .filter({ hasText: `Marked arrived: ${made.name}` });
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(tabB.getByTestId("live-unread")).toHaveText("1 new", {
      timeout: 2000,
    });

    // Looking at the panel clears the count.
    await tabB.getByTestId("live-feed").scrollIntoViewIfNeeded();
    await expect(tabB.getByTestId("live-unread")).toHaveText("");
  });

  test("a burst of bookings becomes one toast", async ({ as }) => {
    const page = await as("owner");
    await page.goto("/dashboard");
    await expect(page.getByTestId("live-status")).toHaveAttribute(
      "data-status",
      "live",
    );
    const names = [1, 2, 3, 4].map((n) => `Burst ${n} ${Date.now()}`);
    await Promise.all(names.map((n) => book(n)));
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: /\d+ updates/ }),
    ).toBeVisible({ timeout: 2000 });
  });

  for (const scheme of SCHEMES) {
    test.describe(`${scheme} theme`, () => {
      test.use({ colorScheme: scheme });

      test("the toast has no serious or critical violations", async ({
        as,
      }) => {
        const made = await book(`Toast Axe ${scheme} ${Date.now()}`);
        const page = await as("owner");
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto("/dashboard");
        await expect(page.getByTestId("live-status")).toHaveAttribute(
          "data-status",
          "live",
        );
        await patientReschedules(made);
        const toast = page
          .locator("[data-sonner-toast]")
          .filter({ hasText: "Rescheduled" });
        await expect(toast).toBeVisible({ timeout: 2000 });
        await settle(page);
        const { violations } = await new AxeBuilder({ page })
          .include("[data-sonner-toaster]")
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        const serious = violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        expect(serious.map((v) => `${v.id}: ${v.help}`).join("\n")).toBe("");
      });
    });
  }
});
