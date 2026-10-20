import { expect, test, type Page } from "./support/csp-guard";

// Vibration, the install surface and the page head, checked in a real browser against the real build.
// Chrome on a laptop has navigator.vibrate but cannot buzz, so each case installs its own recorder
// before the page loads: that is a probe, not a stand-in for the app, which runs unchanged.

type Buzz = { calls: number[][] };
declare global {
  interface Window {
    __buzz: Buzz;
  }
}

const recorder = () => {
  window.__buzz = { calls: [] };
  Object.defineProperty(Navigator.prototype, "vibrate", {
    configurable: true,
    value(pattern: number[]) {
      window.__buzz.calls.push(pattern);
      return true;
    },
  });
};

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

const buzzes = (page: Page) => page.evaluate(() => window.__buzz.calls.length);

// The copy button on the landing page shows a toast, and every toast goes through haptic().
async function tapCopy(page: Page) {
  await page
    .getByRole("button", { name: /^Copy:/ })
    .first()
    .click();
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
}

test("haptic is a silent no-op where the browser cannot vibrate", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Safari has no Vibration API at all.
    delete (Navigator.prototype as { vibrate?: unknown }).vibrate;
  });
  const errors = watchErrors(page);
  await page.goto("/");
  expect(await page.evaluate(() => "vibrate" in navigator)).toBe(false);
  await tapCopy(page);
  await page.getByRole("button", { name: "Display settings" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Light" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Vibrate on actions/ }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("haptic never throws, even if the browser refuses the buzz", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "vibrate", {
      configurable: true,
      value() {
        throw new DOMException("not allowed", "NotAllowedError");
      },
    });
  });
  const errors = watchErrors(page);
  await page.goto("/");
  await tapCopy(page);
  expect(errors).toEqual([]);
});

test.describe("on a phone (touch, Vibration API present)", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a tap buzzes, the menu switch turns it off, and the choice is kept", async ({
    page,
  }) => {
    await page.addInitScript(recorder);
    const errors = watchErrors(page);
    await page.goto("/");
    await tapCopy(page);
    expect(await buzzes(page)).toBeGreaterThanOrEqual(1);

    await page.getByRole("button", { name: "Display settings" }).click();
    const item = page.getByRole("menuitemcheckbox", {
      name: /Vibrate on actions/,
    });
    await expect(item).toBeChecked();
    await item.click();
    expect(
      await page.evaluate(() => localStorage.getItem("clinic:haptics")),
    ).toBe("off");

    const before = await buzzes(page);
    await page.keyboard.press("Escape");
    await tapCopy(page);
    expect(await buzzes(page)).toBe(before);

    await page.reload();
    await page.getByRole("button", { name: "Display settings" }).click();
    await expect(
      page.getByRole("menuitemcheckbox", { name: /Vibrate on actions/ }),
    ).not.toBeChecked();
    expect(errors).toEqual([]);
  });
});

test("a desktop browser that exposes vibrate does not get the switch", async ({
  page,
}) => {
  // Desktop Chrome has navigator.vibrate but a mouse: nothing could buzz, so no switch is offered.
  await page.addInitScript(recorder);
  await page.goto("/");
  expect(await page.evaluate(() => "vibrate" in navigator)).toBe(true);
  expect(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
  ).toBe(false);
  await page.getByRole("button", { name: "Display settings" }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Light" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemcheckbox", { name: /Vibrate on actions/ }),
  ).toHaveCount(0);
});

test("reduced motion silences the buzz", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(recorder);
  await page.goto("/");
  await tapCopy(page);
  expect(await buzzes(page)).toBe(0);
});

test("blocked storage does not break the page or the buzz", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("denied", "SecurityError");
      },
    });
  });
  await page.addInitScript(recorder);
  const errors = watchErrors(page);
  await page.goto("/");
  await tapCopy(page);
  expect(await buzzes(page)).toBeGreaterThanOrEqual(1);
  expect(errors.filter((e) => !/denied|SecurityError/.test(e))).toEqual([]);
});

test("the manifest is complete and every file it names is served", async ({
  request,
}) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const m = await res.json();
  expect(m.shortcuts.map((s: { url: string }) => s.url)).toEqual([
    "/book",
    "/appointments",
  ]);
  expect(
    m.icons.some((i: { purpose: string }) => i.purpose === "maskable"),
  ).toBe(true);
  const files: string[] = [
    ...m.icons.map((i: { src: string }) => i.src),
    ...m.screenshots.map((s: { src: string }) => s.src),
    ...m.shortcuts.flatMap((s: { icons: { src: string }[] }) =>
      s.icons.map((i) => i.src),
    ),
  ];
  for (const f of new Set(files)) {
    const r = await request.get(f);
    expect(r.status(), f).toBe(200);
    expect(r.headers()["content-type"], f).toMatch(/^image\//);
  }
});

test("the head installs well and every public page says who it is", async ({
  page,
}) => {
  await page.goto("/book");
  const meta = (sel: string) =>
    page.locator(sel).first().getAttribute("content");
  expect(await page.locator('meta[name="theme-color"]').count()).toBe(2);
  await expect(
    page.locator('meta[name="theme-color"][media*="dark"]'),
  ).toHaveAttribute("content", "#0a1130");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /\/book$/,
  );
  expect(await meta('meta[property="og:url"]')).toMatch(/\/book$/);
  expect(await meta('meta[property="og:title"]')).toBe(
    "Book a visit | Idyllic Clinic",
  );
  expect(await meta('meta[name="mobile-web-app-capable"]')).toBe("yes");
  expect(await meta('meta[name="apple-mobile-web-app-title"]')).toBe("Idyllic");

  for (const path of ["/", "/about", "/privacy", "/terms", "/data"]) {
    await page.goto(path);
    const canon = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    expect(new URL(canon!).pathname, path).toBe(path);
    expect(
      new URL((await meta('meta[property="og:url"]'))!).pathname,
      path,
    ).toBe(path);
    expect(await meta('meta[property="og:image"]'), path).toBeTruthy();
  }
});

test("the sitemap lists the doctors and robots points to it", async ({
  request,
}) => {
  const xml = await (await request.get("/sitemap.xml")).text();
  expect(xml).toContain("/book</loc>");
  expect(xml).toMatch(/\/book\/[0-9a-f-]{36}<\/loc>/);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain(
    "Sitemap: https://clinic.ericgitangu.com/sitemap.xml",
  );
});

test("the hero ripples run on transform and opacity only, pause when the tab is hidden, and move nothing", async ({
  page,
}) => {
  await page.goto("/");
  const ring = page.locator(".ripples > span").first();
  await expect(ring).toHaveCSS("animation-name", "ripple");
  const before = await page.locator("h1").boundingBox();
  const frames = await page.evaluate(() => {
    const kf = [...document.styleSheets]
      .flatMap((s) => [...s.cssRules])
      .find((r) => r instanceof CSSKeyframesRule && r.name === "ripple");
    return [...(kf as CSSKeyframesRule).cssRules].flatMap((r) =>
      [...(r as CSSKeyframeRule).style].map((p) => p),
    );
  });
  expect([...new Set(frames)].sort()).toEqual(["opacity", "transform"]);
  // A hidden tab pauses the rings.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".ripples")).toHaveAttribute("data-paused", "true");
  await expect(ring).toHaveCSS("animation-play-state", "paused");
  expect(await page.locator("h1").boundingBox()).toEqual(before);
});

test("a client navigation draws the sweep line, and the line moves nothing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Book a visit" }).first().click();
  await expect(page).toHaveURL(/\/book$/);
  const bar = page.locator(".route-sweep");
  await expect(bar).toHaveCSS("position", "fixed");
  await expect(bar).toHaveCSS("animation-name", "route-sweep");
  await expect(bar).toHaveCSS("pointer-events", "none");
});

test("reduced motion removes the ripples and the hero settle", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".ripples")).toBeHidden();
  await expect(page.locator(".route-sweep")).toBeHidden();
  await expect(page.locator(".lotus-settle")).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("an unknown doctor gets the app's own not-found page, not the framework's", async ({
  page,
}) => {
  const res = await page.goto("/book/00000000-0000-0000-0000-000000000000");
  expect(res?.status()).toBe(404);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "We could not find that page",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Book a visit" }).last(),
  ).toBeVisible();
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
    "content",
    /noindex/,
  );
});
