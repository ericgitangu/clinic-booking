// Portraits load on the doctor list (including the ones deferred until scrolled to) and on each
// doctor's page, and patient-facing digits are drawn without the slashed zero. Real production
// build, real API and browser.
import { expect, test, type Page } from "./support/csp-guard";
import { API, pick } from "./api";

type Doctor = { id: string; full_name: string };

async function doctors(): Promise<Doctor[]> {
  const res = await fetch(`${API}/doctors`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { items: Doctor[] }).items;
}

const alt = (name: string) =>
  `${/^dr\.?\s/i.test(name) ? name : `Dr. ${name}`}, AI-generated portrait of a fictional doctor`;

async function expectPortrait(page: Page, name: string) {
  // portraits below the first row load only once scrolled to
  await page.getByRole("heading", { name }).first().scrollIntoViewIfNeeded();
  // (the second card has a hidden twin at the other width; take the one that is shown)
  const img = page
    .locator(`img[alt="${alt(name)}"][src*="/doctors/"]:visible`)
    .first();
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

test("the portrait's alt text is the full sentence", async ({ page }) => {
  const [d] = await doctors();
  await page.goto("/book");
  await expect(
    page.getByRole("img", { name: alt(d.full_name), exact: true }).first(),
  ).toBeVisible();
  await page.goto(`/book/${d.id}`);
  await expect(
    page.getByRole("img", { name: alt(d.full_name), exact: true }),
  ).toBeVisible();
});

test("only the first card's portrait is fetched with high priority (rendered HTML)", async ({
  request,
}) => {
  const html = await (await request.get("/book")).text();
  const imgs = html.match(/<img\b[^>]*\/doctors\/[^>]*>/g) ?? [];
  expect(imgs.length).toBeGreaterThanOrEqual(1);
  const high = imgs.filter((t) => /fetchpriority="high"/i.test(t));
  expect(high).toHaveLength(1);
  expect(imgs[0]).toMatch(/fetchpriority="high"/i);
  expect(imgs[0]).not.toMatch(/loading="lazy"/);
  const [d] = await doctors();
  const slotPage = await (await request.get(`/book/${d.id}`)).text();
  const header = (slotPage.match(/<img\b[^>]*>/g) ?? []).filter((t) =>
    t.includes("/doctors/"),
  );
  expect(header).toHaveLength(1);
  expect(header[0]).toMatch(/fetchpriority="high"/i);
});

// Scrolls the way a person does, so every card passes through the screen (a jump to the bottom
// skips the ones in between, and an observer only sees what is on screen).
async function scrollSlowly(page: Page) {
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => window.scrollBy(0, 150));
    await page.waitForTimeout(60);
  }
}

// Which portraits the browser asks for before anything is scrolled. The first row is never
// deferred: one card below 640 px, two from 640 px.
async function requestedAfterLoad(page: Page) {
  const ids = new Set<string>();
  page.on("request", (r) => {
    const m = /\/doctors\/([0-9a-f-]{36})-(?:128|256|512)\.webp$/.exec(r.url());
    if (m) ids.add(m[1]);
  });
  await page.goto("/book");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500); // observers run after hydration
  return ids;
}

test("at 360 px only the first card's portrait is fetched up front; the rest wait for the scroll", async ({
  browser,
}) => {
  const list = await doctors();
  const context = await browser.newContext({
    viewport: { width: 360, height: 420 },
  });
  const page = await context.newPage();
  const ids = await requestedAfterLoad(page);
  expect([...ids]).toEqual([list[0].id]);
  await scrollSlowly(page);
  await expect.poll(() => ids.size).toBe(list.length);
  await context.close();
});

test("at 1280 px the first row (two cards) is fetched up front and the later rows wait", async ({
  browser,
}) => {
  const list = await doctors();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 420 },
  });
  const page = await context.newPage();
  const ids = await requestedAfterLoad(page);
  expect(ids.has(list[0].id)).toBe(true);
  expect(ids.has(list[1].id)).toBe(true);
  expect(ids.has(list[4].id)).toBe(false);
  await scrollSlowly(page);
  await expect.poll(() => ids.size).toBe(list.length);
  await context.close();
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
