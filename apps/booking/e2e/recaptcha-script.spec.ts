import { expect, test } from "./support/csp-guard";
import { addDays, doctorAt, slotsOn, today } from "./api";
import { newPerson, sessionCookies } from "./support/auth";

// Regression test for a production outage: the release builds with no Vercel project environment, so
// NEXT_PUBLIC_RECAPTCHA_SITE_KEY was empty at build time, the details page never loaded reCAPTCHA, and
// every booking was rejected with "missing-token". It runs only against a build made WITH the public
// build environment (scripts/ci/public-build.env), the way the release builds; the ordinary e2e build
// has no site key on purpose. Nothing is booked and Google is never contacted (the request is aborted).
test.skip(
  !process.env.E2E_PUBLIC_BUILD,
  "needs a production build made with scripts/ci/public-build.env (E2E_PUBLIC_BUILD=1)",
);

test("the details page loads reCAPTCHA Enterprise with the site key it was built with", async ({
  browser,
}) => {
  const expected = process.env.E2E_EXPECT_SITE_KEY;
  expect(
    expected,
    "E2E_EXPECT_SITE_KEY must hold the key from public-build.env",
  ).toBeTruthy();

  const doctorId = await doctorAt(1);
  let startsAt = "";
  for (let n = 1; n <= 14 && !startsAt; n++) {
    startsAt = (await slotsOn(doctorId, addDays(today(), n)))[0] ?? "";
  }
  expect(startsAt, "no bookable slot in the next 14 days").not.toBe("");

  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(newPerson()));
  await context.route("**/recaptcha/**", (route) => route.abort());
  const page = await context.newPage();
  await page.goto(
    `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`,
  );

  const script = page.locator("script#recaptcha-enterprise");
  await expect(script).toHaveAttribute(
    "src",
    `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(expected!)}`,
  );
  await context.close();
});
