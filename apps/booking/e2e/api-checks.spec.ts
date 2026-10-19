import { expect, test } from "@playwright/test";

// The landing page's read-only run: the collection's GET requests, from the browser, against this
// site's /api and the real API behind it.
test("the API checks run read-only from the landing page and pass", async ({
  page,
}) => {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/"))
      sent.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  await page.goto("/");
  const panel = page.getByTestId("api-checks");
  await expect(
    panel.getByRole("checkbox", { name: /Also run writes/ }),
  ).not.toBeChecked();
  await panel.getByRole("button", { name: "Run the API checks" }).click();

  const summary = page.getByTestId("api-checks-summary");
  await expect(summary).toHaveText(/^(\d+) of \1 requests passed/, {
    timeout: 60_000,
  });
  await expect(panel.locator("li[data-state=fail]")).toHaveCount(0);
  await expect(panel.locator("li[data-state=skip]")).toHaveCount(0);
  expect(await panel.locator("li[data-state=pass]").count()).toBeGreaterThan(
    10,
  );
  // Problem responses are checked as problems: the expected code is on the row.
  await expect(panel).toContainText("expected 404 APPOINTMENT_NOT_FOUND");

  expect(sent.length).toBeGreaterThan(10);
  expect(sent.filter((s) => !s.startsWith("GET "))).toEqual([]);
});
