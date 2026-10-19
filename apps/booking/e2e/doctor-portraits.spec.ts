// Portraits load on the doctor list (including the ones deferred until scrolled to) and on each
// doctor's page, and patient-facing digits are drawn without the slashed zero. Real production
// build, real API and browser.
import { expect, test, type Page } from "@playwright/test";
import { API, pick } from "./api";

type Doctor = { id: string; full_name: string };

async function doctors(): Promise<Doctor[]> {
  const res = await fetch(`${API}/doctors`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { items: Doctor[] }).items;
}

async function expectPortrait(page: Page, name: string) {
  // portraits below the first row load only once scrolled to
  await page.getByRole("heading", { name }).first().scrollIntoViewIfNeeded();
  const img = page.locator(`img[alt="${name}"][src*="/doctors/"]`).first();
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  const src = await img.evaluate((el: HTMLImageElement) => el.currentSrc);
  expect(src).toMatch(/\/doctors\/[0-9a-f-]{36}-(128|256|512)\.webp$/);
  const res = await page.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/webp");
  await expect(img).toHaveAttribute("width", /^\d+$/);
  await expect(img).toHaveAttribute("height", /^\d+$/);
}

test("all five doctor cards end up showing their portrait", async ({
  page,
}) => {
  const list = await doctors();
  expect(list).toHaveLength(5);
  await page.goto("/book");
  for (const d of list) await expectPortrait(page, d.full_name);
});

test("each doctor's page shows the portrait", async ({ page }) => {
  for (const d of await doctors()) {
    await page.goto(`/book/${d.id}`);
    await expectPortrait(page, d.full_name);
  }
});

// Atkinson Hyperlegible draws its zero with a slash and has no alternate, so the digits come from
// the visitor's system face (see globals.css). Asked of the browser, not read from CSS: which
// platform font drew the digits of each patient-facing time, date and day chip.
test("times, dates and day chips draw their digits in the system face, in tabular figures", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const { doctorId, day } = await pick(0);
  await page.goto(`/book/${doctorId}?date=${day}`);
  await expect(page.getByText(/^\d\d:\d\d$/).first()).toBeVisible();

  // Is there a system face to draw digits with on this machine? If not, the browser (correctly)
  // keeps the page font and there is nothing to assert about the system face.
  const hasSystemFace = await page.evaluate(
    async () =>
      (await document.fonts.load('16px "Clinic Digits"', "0")).length > 0,
  );
  expect(
    hasSystemFace,
    "no system face from the Clinic Digits list is installed",
  ).toBe(true);

  // Tag the smallest elements of the page body that show digits: slot chips, day chips, dates.
  const count = await page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll("main *")) {
      if (el.children.length === 0 && /\d/.test(el.textContent ?? "")) {
        el.setAttribute("data-digits", String(n++));
      }
    }
    return n;
  });
  expect(count).toBeGreaterThanOrEqual(5);

  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  for (let i = 0; i < count; i++) {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-digits="${i}"]`,
    });
    const el = page.locator(`[data-digits="${i}"]`);
    const text = (await el.textContent()) ?? "";
    const digits = (text.match(/\d/g) ?? []).length;
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    // The page font is Atkinson Hyperlegible Next (the browser reports its real family name).
    const system = fonts
      .filter((f) => !/atkinson/i.test(f.familyName))
      .reduce((n, f) => n + f.glyphCount, 0);
    expect(
      system,
      `"${text}" is drawn by ${JSON.stringify(fonts.map((f) => [f.familyName, f.glyphCount]))}`,
    ).toBeGreaterThanOrEqual(digits);
    expect(
      await el.evaluate((e) => getComputedStyle(e).fontVariantNumeric),
    ).toContain("tabular-nums");
  }
  await context.close();
});
