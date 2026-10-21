// A reviewer pass against the real API and database: the owner makes one in the UI, a person with a
// fresh Google account opens the link and accepts, and the owner revokes it. The API allows an owner
// five passes a day, so this makes one per run and uses it for the whole story.
import { newPerson } from "./support/oauth-flow";
import { EMAIL, internal } from "./support/stack";
import { expect, signIn, tap, test } from "./support/fixtures";

test("the owner makes a pass, a new person joins with it, and a revoked pass is refused", async ({
  as,
  browser,
}) => {
  const page = await as("owner");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/access");
  await expect(
    page.getByRole("heading", { name: "Reviewer passes" }),
  ).toBeVisible();
  // The defaults: admin, 5 people, 14 days.
  await expect(page.getByLabel("People (1 to 10)")).toHaveValue("5");
  await expect(page.getByLabel("Days (1 to 30)")).toHaveValue("14");
  await tap(page.getByRole("button", { name: "Make a pass" }));
  await expect(page.getByText("Reviewer pass made.").first()).toBeVisible();

  // The link is shown once, with the warning, and a reload does not show it again.
  const box = page.getByTestId("pass-link-box");
  await expect(box).toContainText("Anyone with this link can sign in");
  await expect(box).toContainText(
    "it does not remove people who already joined",
  );
  const link = await page.getByLabel("Pass link").inputValue();
  expect(link).toMatch(/\/pass\/[A-Za-z0-9_-]{20,}$/);
  const path = new URL(link).pathname;
  const mine = page.getByTestId("pass-list").locator("li").first();
  await expect(mine).toContainText("Admin pass, 0 of 5 used");
  await expect(mine).toContainText("Active");
  await page.reload();
  await expect(page.getByLabel("Pass link")).toHaveCount(0);

  // Signed out, the page asks for a Google sign-in and does not accept anything by itself.
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(path);
  await expect(
    ap.getByText("Sign in with any Google account to accept."),
  ).toBeVisible();
  await anon.close();

  // A person nobody invited opens it, accepts, and lands on the dashboard as an admin.
  const joiner = newPerson().email;
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await signIn(ctx, joiner);
  const jp = await ctx.newPage();
  await jp.goto(path);
  await expect(jp.getByText(joiner)).toBeVisible();
  // Opening the link used nothing: the seat is taken by the button.
  await jp.getByRole("button", { name: "Accept" }).click();
  await expect(jp).toHaveURL(/\/dashboard$/);
  await expect(jp.getByTestId("staff-role")).toHaveText("Admin");
  // Admin powers, but no passes: those are the owner's.
  await jp.goto("/access");
  await expect(jp.getByLabel("Email to invite")).toBeVisible();
  await expect(
    jp.getByRole("heading", { name: "Reviewer passes" }),
  ).toHaveCount(0);

  // Clicking the link again is harmless and takes no second seat.
  await jp.goto(path);
  await jp.getByRole("button", { name: "Accept" }).click();
  await expect(jp).toHaveURL(/\/dashboard$/);

  await page.reload();
  const row = page.getByTestId("pass-list").locator("li").first();
  await expect(row).toContainText("Admin pass, 1 of 5 used");
  await expect(row).toContainText(joiner);

  // Revoking stops new sign-ins; the person who joined keeps their access.
  await tap(row.getByRole("button", { name: /^Revoke the admin pass/ }));
  const ask = page.getByRole("dialog", { name: "Revoke this pass?" });
  await expect(ask).toContainText(
    "People who already joined keep their access",
  );
  await ask.getByRole("button", { name: "Revoke pass" }).click();
  await expect(page.getByText(/^Pass revoked\./)).toBeVisible();
  await expect(row).toContainText("Revoked");

  const late = newPerson().email;
  const lctx = await browser.newContext();
  await signIn(lctx, late);
  const lp = await lctx.newPage();
  await lp.goto(path);
  await lp.getByRole("button", { name: "Accept" }).click();
  await expect(lp.locator("main p[role=alert]")).toHaveText(
    "That reviewer pass is not valid.",
  );
  await lctx.close();

  await jp.goto("/dashboard");
  await expect(jp.getByTestId("staff-role")).toHaveText("Admin");
  await ctx.close();
});

test("an admin and a viewer do not see the passes, and the API refuses them", async ({
  browser,
}) => {
  for (const who of ["admin", "viewer"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await signIn(ctx, EMAIL[who]);
    const page = await ctx.newPage();
    const res = await page.goto("/access");
    if (who === "admin") {
      expect(res?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: "Invitations" }),
      ).toBeVisible();
    } else {
      expect(res?.status()).toBe(403);
    }
    await expect(
      page.getByRole("heading", { name: "Reviewer passes" }),
    ).toHaveCount(0);
    const made = await internal(
      "POST",
      "/internal/admin/passes",
      { email: EMAIL[who], role: who },
      {},
    );
    expect(made.status).toBe(403);
    await ctx.close();
  }
});

test("a malformed link says so and offers no button", async ({ as }) => {
  const page = await as("owner");
  await page.goto("/pass/short");
  await expect(
    page.getByText("That reviewer pass link is not valid."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);
});
