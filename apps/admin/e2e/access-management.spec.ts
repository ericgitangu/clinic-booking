// The owner's Access page against the real API and the real staff_access table.
import { internal, OWNER } from "./support/stack";
import { expect, signIn, test } from "./support/fixtures";

interface AccessList {
  items: {
    email: string;
    role: string;
    revoked_at: string | null;
    source: string;
  }[];
}

const owner = { email: OWNER, role: "owner" };

async function entry(email: string) {
  const res = await internal<AccessList>(
    "GET",
    "/internal/admin/access",
    owner,
  );
  return res.body.items.find((i) => i.email === email);
}

test("the owner row is fixed and the seeded people are listed", async ({
  as,
}) => {
  const page = await as("owner");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/access");
  const table = page.getByTestId("access-table");
  const ownerRow = table
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: OWNER, exact: true }) });
  await expect(ownerRow).toContainText("Fixed by configuration");
  await expect(ownerRow.getByRole("button")).toHaveCount(0);
  await expect(table.getByText("e2e-admin@clinic.example")).toBeVisible();
  await expect(table.getByText("e2e-viewer@clinic.example")).toBeVisible();
  // The revoked person is listed apart, not among the people with access.
  await expect(page.getByRole("heading", { name: "Revoked" })).toBeVisible();
  await expect(table.getByText("e2e-revoked@clinic.example")).toHaveCount(0);
});

test("adds, changes and revokes someone, with confirmation, and the database follows", async ({
  as,
}) => {
  const email = `nurse-${Date.now()}@clinic.example`;
  const page = await as("owner");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/access");
  const table = page.getByTestId("access-table");

  await page.getByRole("button", { name: "Add someone" }).click();
  await page.getByLabel("Google email").fill(email);
  await page.getByRole("button", { name: "Add access" }).click();
  await expect(page.getByText(`Access granted to ${email}.`)).toBeVisible();
  await expect(table.getByText(email)).toBeVisible();
  expect(await entry(email)).toMatchObject({
    role: "viewer",
    revoked_at: null,
    source: "db",
  });

  await page.getByRole("button", { name: `Change role of ${email}` }).click();
  await page.locator("#change-role").click();
  await page.getByRole("option", { name: /^Admin/ }).click();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText(`${email} is now admin.`)).toBeVisible();
  expect(await entry(email)).toMatchObject({ role: "admin" });

  await page.getByRole("button", { name: `Revoke access of ${email}` }).click();
  await expect(page.getByRole("dialog")).toContainText(email);
  await page
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(page.getByText(`Access revoked for ${email}.`)).toBeVisible();
  await expect(table.getByText(email)).toHaveCount(0);
  expect((await entry(email))?.revoked_at).not.toBeNull();
});

test("a duplicate is refused with a plain message", async ({ as }) => {
  const page = await as("owner");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/access");
  await page.getByRole("button", { name: "Add someone" }).click();
  await page.getByLabel("Google email").fill("e2e-admin@clinic.example");
  await page.getByRole("button", { name: "Add access" }).click();
  await expect(
    page.getByText("That email already has access. Change its role instead."),
  ).toBeVisible();
});

test("a revoke takes effect on the person's very next request", async ({
  as,
  browser,
}) => {
  const email = `temp-${Date.now()}@clinic.example`;
  const ownerPage = await as("owner");
  await ownerPage.setViewportSize({ width: 1280, height: 900 });
  await ownerPage.goto("/access");
  await ownerPage.getByRole("button", { name: "Add someone" }).click();
  await ownerPage.getByLabel("Google email").fill(email);
  await ownerPage.getByRole("button", { name: "Add access" }).click();
  await expect(
    ownerPage.getByText(`Access granted to ${email}.`),
  ).toBeVisible();

  const ctx = await browser.newContext();
  await signIn(ctx, email);
  const person = await ctx.newPage();
  const allowed = await person.goto("/dashboard");
  expect(allowed?.status()).toBe(200);
  await expect(person.getByTestId("staff-role")).toHaveText("Viewer");

  await ownerPage
    .getByRole("button", { name: `Revoke access of ${email}` })
    .click();
  await ownerPage
    .getByRole("button", { name: "Revoke access", exact: true })
    .click();
  await expect(
    ownerPage.getByText(`Access revoked for ${email}.`),
  ).toBeVisible();

  // Same browser, same cookie, no sign-out: the next page load is refused.
  const denied = await person.goto("/dashboard");
  expect(denied?.status()).toBe(403);
  await expect(
    person.getByRole("heading", { name: "You do not have access" }),
  ).toBeVisible();
  await ctx.close();
});

test("owner and admin see the Access and Audit links, a viewer does not", async ({
  browser,
}) => {
  for (const [who, sees] of [
    ["owner", true],
    ["admin@clinic.example", true],
    ["viewer@clinic.example", false],
  ] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await signIn(ctx, who === "owner" ? OWNER : `e2e-${who}`);
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
    for (const name of ["Access", "Audit"]) {
      await expect(nav.getByRole("link", { name })).toHaveCount(sees ? 1 : 0);
    }
    await ctx.close();
  }
});
