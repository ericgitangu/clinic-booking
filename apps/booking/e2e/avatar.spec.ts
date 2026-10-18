import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { newPerson, sessionCookies } from "./support/auth";

// The header shows the person's Google profile picture, or their initials. Google's picture host
// (lh3.googleusercontent.com) is an external third party and is stood in for here: its answer is
// a one-pixel PNG, or a failure. Everything else is the real app, session and browser.
const PICTURE = "https://lh3.googleusercontent.com/a/e2e-avatar=s96-c";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function signedIn(
  browser: Parameters<Parameters<typeof test>[2]>[0]["browser"],
  image: string | undefined,
  googleAnswers: "picture" | "failure",
) {
  const person = newPerson({ image });
  const context: BrowserContext = await browser.newContext();
  await context.route("https://lh3.googleusercontent.com/**", (route) =>
    googleAnswers === "picture"
      ? route.fulfill({ status: 200, contentType: "image/png", body: PNG })
      : route.abort("failed"),
  );
  await context.addCookies(await sessionCookies(person));
  const page = await context.newPage();
  await page.goto("/about");
  return { context, page, person };
}

const trigger = (page: Page, name: string) =>
  page.getByRole("button", { name: `Account menu for ${name}` });

test("the header shows the Google profile picture, 32px and round, with its alt text", async ({
  browser,
}) => {
  const { context, page, person } = await signedIn(browser, PICTURE, "picture");
  const img = trigger(page, person.name).getByRole("img", {
    name: `${person.name}'s profile picture`,
  });
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", PICTURE);
  const box = await img.boundingBox();
  expect(Math.round(box!.width)).toBe(32);
  expect(Math.round(box!.height)).toBe(32);
  // Fully round: the radius is at least half the 32px side (rounded-full is a huge value).
  expect(
    await img.evaluate((el) => parseFloat(getComputedStyle(el).borderRadius)),
  ).toBeGreaterThanOrEqual(16);
  // The signed-in name is not printed beside it any more.
  await expect(page.getByText(person.name, { exact: true })).toHaveCount(0);
  await context.close();
});

test("with no picture the header shows initials", async ({ browser }) => {
  const { context, page, person } = await signedIn(
    browser,
    undefined,
    "picture",
  );
  const button = trigger(page, person.name);
  await expect(button).toBeVisible();
  await expect(button.getByRole("img")).toHaveCount(0);
  const initials = person.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  await expect(button).toContainText(initials);
  await context.close();
});

test("when the picture fails to load the header falls back to initials", async ({
  browser,
}) => {
  const { context, page, person } = await signedIn(browser, PICTURE, "failure");
  const button = trigger(page, person.name);
  await expect(button).toBeVisible();
  await expect(button.getByRole("img")).toHaveCount(0);
  await expect(button).toContainText(
    person.name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase(),
  );
  await context.close();
});

test("the menu opens from the keyboard, shows who and where, and the focus ring is visible", async ({
  browser,
}) => {
  const { context, page, person } = await signedIn(browser, PICTURE, "picture");
  const button = trigger(page, person.name);
  await button.focus();
  await expect(button).toBeFocused();
  // Keyboard focus shows a ring (Button's focus-visible style): a non-empty box-shadow or outline.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const ring = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return `${s.boxShadow} ${s.outlineStyle}`;
  });
  expect(ring).not.toMatch(/^none none$/);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu").getByText(person.email)).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "My appointments" }),
  ).toHaveAttribute("href", "/appointments");
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await context.close();
});

test("axe finds nothing serious with the avatar menu closed and open, light and dark", async ({
  browser,
}) => {
  for (const scheme of ["light", "dark"] as const) {
    const { context, page, person } = await signedIn(
      browser,
      PICTURE,
      "picture",
    );
    await page.emulateMedia({ colorScheme: scheme });
    const audit = async () =>
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
    await expect(trigger(page, person.name)).toBeVisible();
    expect(await audit(), `${scheme}, closed`).toEqual([]);
    await trigger(page, person.name).click();
    await expect(page.getByRole("menu")).toBeVisible();
    // The menu fades in; axe must read its final colours, not a frame of the fade.
    await page
      .getByRole("menu")
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect(await audit(), `${scheme}, open`).toEqual([]);
    await context.close();
  }
});
