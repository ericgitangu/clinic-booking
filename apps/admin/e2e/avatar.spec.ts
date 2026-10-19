import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sessionCookies } from "./support/test-auth";

// The staff bar shows the person's Google profile picture, or their initials, as the account menu.
// Google's picture host is an external third party and is stood in for (a one-pixel PNG, or a
// failure); the app, the session and the browser are real.
const PICTURE = "https://lh3.googleusercontent.com/a/e2e-admin-avatar=s96-c";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function open(
  browser: Parameters<Parameters<typeof test>[2]>[0]["browser"],
  image: string | undefined,
  google: "picture" | "failure",
) {
  // A fresh address each time: Better Auth keeps the picture it saw when the account was made.
  const email = `e2e-avatar-${randomUUID().slice(0, 8)}@clinic.example`;
  const context = await browser.newContext();
  await context.route("https://lh3.googleusercontent.com/**", (route) =>
    google === "picture"
      ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
      : route.abort("failed"),
  );
  await context.addCookies(await sessionCookies(email, image));
  const page = await context.newPage();
  await page.goto("/dashboard");
  return { context, page, name: email.split("@")[0], email };
}

const trigger = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name: `Account menu for ${name}` });

test("the header shows the profile picture, 32px, keeps the role and puts the email in the menu", async ({
  browser,
}) => {
  const { context, page, name, email } = await open(
    browser,
    PICTURE,
    "picture",
  );
  const img = trigger(page, name).getByRole("img", {
    name: `${name}'s profile picture`,
  });
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", PICTURE);
  const box = await img.boundingBox();
  expect([Math.round(box!.width), Math.round(box!.height)]).toEqual([32, 32]);
  await expect(page.getByTestId("staff-role")).toBeVisible();
  await trigger(page, name).click();
  await expect(page.getByRole("menu")).toContainText(email);
  await context.close();
});

test("no picture, or one that fails to load, shows initials", async ({
  browser,
}) => {
  for (const [image, google] of [
    [undefined, "picture"],
    [PICTURE, "failure"],
  ] as const) {
    const { context, page, name } = await open(browser, image, google);
    await expect(trigger(page, name)).toBeVisible();
    await expect(trigger(page, name).getByRole("img")).toHaveCount(0);
    // Drawn by CSS from data-initials: the button's name is only its aria-label (WCAG 2.5.3).
    const mark = trigger(page, name).locator("[data-initials]");
    const initials = name.slice(0, 1).toUpperCase();
    await expect(mark).toHaveAttribute("data-initials", initials);
    expect(
      await mark.evaluate((el) => getComputedStyle(el, "::before").content),
    ).toBe(`"${initials}"`);
    await expect(trigger(page, name)).toHaveText("");
    await context.close();
  }
});

test("the menu signs out, and axe finds nothing serious with it open", async ({
  browser,
}) => {
  // No picture: the initials are the visible content of the button, the case WCAG 2.5.3 checks.
  const { context, page, name } = await open(browser, undefined, "picture");
  await trigger(page, name).click();
  await expect(page.getByRole("menu")).toBeVisible();
  // The menu fades in; axe must read its final colours, not a frame of the fade.
  await page
    .getByRole("menu")
    .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious).toEqual([]);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(trigger(page, name)).toHaveCount(0);
  await context.close();
});
