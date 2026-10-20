import { execFileSync } from "node:child_process";
import { type BrowserContext, expect, test } from "./support/csp-guard";
import { API } from "./api";

const hasTool = (name: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

test("the status line shows the API's readiness", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("api-status")).toContainText("API ready");
});

// Aborts every request that leaves this origin and records it, so a page that still reaches for a
// CDN fails here whether or not the machine has internet.
async function blockOffOrigin(context: BrowserContext): Promise<string[]> {
  const offOrigin: string[] = [];
  await context.route(
    (url) => url.hostname !== "localhost" && url.hostname !== "127.0.0.1",
    (route) => {
      offOrigin.push(route.request().url());
      return route.abort();
    },
  );
  return offOrigin;
}

test("every evidence card opens its operation in Swagger", async ({
  page,
  context,
}) => {
  const offOrigin = await blockOffOrigin(context);
  await page.goto("/");
  const links = await page
    .locator('a[href^="/docs#/"]')
    .evaluateAll((as) => as.map((a) => a.getAttribute("href") as string));
  expect(links).toHaveLength(6);
  for (const href of new Set(links)) {
    const [, tag, opId] = href.split("#")[1].split("/");
    // A fresh tab for each, as a click from the landing page would be: Swagger reads the link on load.
    const tab = await context.newPage();
    await tab.goto(href);
    // Swagger UI marks the operation it deep-linked to as open.
    const op = tab.locator(`#operations-${tag}-${opId}`);
    await expect(op, href).toHaveClass(/is-open/);
    await tab.close();
  }
  expect(offOrigin, "requests that left this origin").toEqual([]);
});

test("ReDoc renders the contract from this origin", async ({
  page,
  context,
}) => {
  const offOrigin = await blockOffOrigin(context);
  await page.goto("/redoc");
  await expect(
    page.getByRole("heading", { name: "Idyllic Clinic API", level: 1 }),
  ).toBeVisible();
  expect(offOrigin, "requests that left this origin").toEqual([]);
});

test("the evidence cards link to screens that load", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const screens = await page
    .locator('li a[href="/book"], li a[href="/appointments"]')
    .evaluateAll((as) => [
      ...new Set(as.map((a) => a.getAttribute("href") as string)),
    ]);
  expect(screens.sort()).toEqual(["/appointments", "/book"]);
  for (const s of screens) expect((await request.get(s)).status(), s).toBe(200);
});

test("the three copy-paste steps work against the API", async ({ page }) => {
  test.skip(!hasTool("jq") || !hasTool("curl"), "needs curl and jq");
  test.setTimeout(120_000);
  await page.goto("/");
  const blocks = await page.locator("pre code").allTextContents();
  expect(blocks).toHaveLength(3);
  // Point the live address at the API under test and run the steps in one shell, as a reader would.
  const script = blocks
    .join("\n")
    .replaceAll("https://clinic.ericgitangu.com/api", API);
  const out = execFileSync("bash", ["-c", `set -e\n${script}`], {
    encoding: "utf8",
    timeout: 100_000,
  });
  expect(out).toMatch(/HTTP 201/);
  expect(out).toMatch(/HTTP 409/);
  expect(out).toContain("SLOT_TAKEN");
});
