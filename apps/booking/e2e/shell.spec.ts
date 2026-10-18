import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "./support/csp-guard";
import { hhmm, pick, slotsOn } from "./api";
import { newPerson, sessionCookies } from "./support/auth";

// The shared frame (header, way back, footer) on every kind of route, in the real build against the
// real API. Assertions use roles and names, the way a person or a screen reader finds things.

const PHONE = { width: 360, height: 740 };
const DESKTOP = { width: 1280, height: 800 };

type Case = {
  name: string;
  path: (ids: Ids) => string;
  // The page the way back leads to; null on a root page (no way back is drawn).
  parent: string | null | ((ids: Ids) => string);
  parentName: string | null;
  // The phone link's words, where they are not "Back to <parent>".
  phoneText?: string;
  signedIn?: boolean;
  status?: number;
};
type Ids = {
  doctorId: string;
  day: string;
  startsAt: string;
  appointmentId: string;
};

const CASES: Case[] = [
  { name: "home", path: () => "/", parent: null, parentName: null },
  { name: "book", path: () => "/book", parent: "/", parentName: "Home" },
  {
    name: "choose a time",
    path: (i) => `/book/${i.doctorId}`,
    parent: "/book",
    parentName: "Book a visit",
  },
  {
    name: "your details",
    path: (i) =>
      `/book/${i.doctorId}/details?starts_at=${encodeURIComponent(i.startsAt)}`,
    parent: (i) => `/book/${i.doctorId}`,
    parentName: "Choose a time",
    signedIn: true,
  },
  {
    name: "confirmed",
    path: (i) => `/book/confirmed/${i.appointmentId}`,
    parent: "/appointments",
    parentName: "My appointments",
    signedIn: true,
  },
  {
    name: "my appointments",
    path: () => "/appointments",
    parent: "/",
    parentName: "Home",
    signedIn: true,
  },
  {
    name: "my appointments, signed out",
    path: () => "/appointments",
    parent: "/",
    parentName: "Home",
  },
  {
    name: "reschedule",
    path: (i) => `/appointments/${i.appointmentId}/reschedule`,
    parent: "/appointments",
    parentName: "My appointments",
    signedIn: true,
  },
  { name: "about", path: () => "/about", parent: "/", parentName: "Home" },
  { name: "privacy", path: () => "/privacy", parent: "/", parentName: "Home" },
  { name: "terms", path: () => "/terms", parent: "/", parentName: "Home" },
  { name: "data", path: () => "/data", parent: "/", parentName: "Home" },
  {
    name: "swagger docs",
    path: () => "/docs",
    parent: "/",
    parentName: "Home",
    phoneText: "Back to the app",
  },
  {
    name: "redoc",
    path: () => "/redoc",
    parent: "/",
    parentName: "Home",
    phoneText: "Back to the app",
  },
  {
    name: "404",
    path: () => "/no-such-page",
    parent: "/",
    parentName: "Home",
    status: 404,
  },
  {
    name: "error",
    path: () => "/e2e-shell/error",
    // An error page keeps the trail of the address it failed on; this one is not in the list.
    parent: "/",
    parentName: "Home",
    status: 500,
  },
];

let ids: Ids;
let cookies: Awaited<ReturnType<typeof sessionCookies>>;

// Each worker books its own time, so two workers never meet on the same one.
test.beforeAll(async ({ browser }, testInfo) => {
  const { doctorId, day, slots } = await pick(3, { doctor: 2 });
  const person = newPerson();
  cookies = await sessionCookies(person);
  const context = await browser.newContext();
  await context.addCookies(cookies);
  const page = await context.newPage();
  const startsAt = slots[testInfo.parallelIndex];
  await page.goto(
    `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`,
  );
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
  ids = {
    doctorId,
    day,
    startsAt,
    appointmentId: page.url().split("/").pop()!,
  };
  await context.close();
});

async function open(
  browser: Browser,
  c: Case,
  viewport: { width: number; height: number },
  colorScheme: "light" | "dark" = "light",
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ viewport, colorScheme });
  if (c.signedIn) await context.addCookies(cookies);
  const page = await context.newPage();
  const res = await page.goto(c.path(ids));
  if (c.status) expect(res?.status(), c.name).toBe(c.status);
  return { page, context };
}

const parentOf = (c: Case) =>
  typeof c.parent === "function" ? c.parent(ids) : c.parent;

test.describe("every route has the header, the footer and a way back", () => {
  for (const c of CASES) {
    test(`${c.name}: desktop trail ends in a link to its parent`, async ({
      browser,
    }) => {
      const { page, context } = await open(browser, c, DESKTOP);
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      const trail = page.getByRole("navigation", { name: "Breadcrumb" });
      if (c.parent === null) {
        await expect(trail).toHaveCount(0);
      } else {
        const parent = parentOf(c)!;
        const link = trail.getByRole("link", { name: c.parentName! });
        await expect(link).toHaveAttribute("href", parent);
        expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(trail.locator('[aria-current="page"]')).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(
          new RegExp(`${parent.replace(/[/?]/g, "\\$&")}(\\?.*)?$`),
        );
        await expect(page.getByRole("banner")).toBeVisible();
      }
      await context.close();
    });

    test(`${c.name}: a phone gets one "Back to" link`, async ({ browser }) => {
      const { page, context } = await open(browser, c, PHONE);
      const back = page
        .getByRole("navigation", { name: "Breadcrumb" })
        .getByRole("link", { name: /^Back to / });
      if (c.parent === null) {
        await expect(back).toHaveCount(0);
      } else {
        await expect(back).toHaveText(c.phoneText ?? `Back to ${c.parentName}`);
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await expect(back).toHaveAttribute("href", parentOf(c)!);
        await back.click();
        await expect(page.getByRole("banner")).toBeVisible();
      }
      await context.close();
    });
  }
});

test.describe("the header", () => {
  for (const [label, viewport] of [
    ["phone", PHONE],
    ["desktop", DESKTOP],
  ] as const) {
    for (const path of ["/", "/privacy", "/data"]) {
      test(`stays at the top of the ${label} while ${path} scrolls`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.goto(path);
        const header = page.getByRole("banner");
        await expect(header).toBeVisible();
        const y = await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return window.scrollY;
        });
        expect(y, `${path} must be long enough to scroll`).toBeGreaterThan(200);
        await expect(header).toBeInViewport({ ratio: 1 });
        expect((await header.boundingBox())!.y).toBe(0);
        await context.close();
      });
    }
  }

  test("is 56px tall on a 360px phone and does not move the page when the menu opens", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/privacy");
    const header = page.getByRole("banner");
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(56);
    const title = page.getByRole("heading", { level: 1 });
    const before = (await title.boundingBox())!;
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("navigation", { name: "Menu" })).toBeVisible();
    expect(await title.boundingBox()).toEqual(before);
    await context.close();
  });

  test("shifts nothing while the page settles", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.addInitScript(() => {
      (window as unknown as { shifts: number }).shifts = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          value: number;
          hadRecentInput: boolean;
        }[])
          if (!e.hadRecentInput)
            (window as unknown as { shifts: number }).shifts += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/privacy");
    // The signed-in menu loads when the browser is idle (within two seconds).
    await page.waitForTimeout(2500);
    const shifts = await page.evaluate(
      () => (window as unknown as { shifts: number }).shifts,
    );
    expect(shifts).toBeLessThan(0.01);
    await context.close();
  });

  test("marks where you are with aria-current=page", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(`/book/${ids.doctorId}`);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(
      nav.getByRole("link", { name: "Book a visit" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      nav.getByRole("link", { name: "My appointments" }),
    ).not.toHaveAttribute("aria-current", "page");
    await page.goto("/privacy");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
  });

  test("opens its menu from the keyboard, closes on Escape and returns focus", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/privacy");
    const button = page.getByRole("button", { name: "Open menu" });
    await button.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("navigation", { name: "Menu" });
    await expect(menu).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close menu" }),
    ).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("link").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
    await context.close();
  });
});

test.describe("the skip link", () => {
  for (const c of CASES.filter((x) => !x.signedIn)) {
    test(`is the first stop on ${c.name} and moves focus to the content`, async ({
      browser,
    }) => {
      const { page, context } = await open(browser, c, DESKTOP);
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Skip to content" });
      await expect(skip).toBeFocused();
      await expect(skip).toBeVisible();
      await page.keyboard.press("Enter");
      // The docs viewers draw their own main landmark, so there the target is the wrapper around it.
      const docs = ["/docs", "/redoc"].includes(c.path(ids));
      await expect(
        docs ? page.locator("#main") : page.getByRole("main"),
      ).toBeFocused();
      await context.close();
    });
  }
});

test.describe("anchors clear the sticky header", () => {
  test("a #fragment target lands below it", async ({ browser }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/privacy");
    // Let the page finish hydrating first, or React replaces what is added below.
    await page.waitForLoadState("networkidle");
    // Add a target far down the page, so the jump needs a real scroll whatever the page holds.
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "3000px";
      const target = document.createElement("h2");
      target.id = "shell-test-target";
      target.textContent = "Target";
      document.querySelector("main")!.append(spacer, target);
    });
    await page.evaluate(() => (location.hash = "shell-test-target"));
    await page.waitForTimeout(300);
    const top = await page.evaluate(
      () =>
        document.getElementById("shell-test-target")!.getBoundingClientRect()
          .top,
    );
    const header = (await page.getByRole("banner").boundingBox())!;
    expect(top).toBeGreaterThanOrEqual(header.height);
    await context.close();
  });
});

test.describe("accessibility of the frame", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const c of CASES.filter((x) => !x.signedIn)) {
      for (const [label, viewport] of [
        ["desktop", DESKTOP],
        ["phone", PHONE],
      ] as const) {
        test(`${c.name} on ${label} in ${scheme} has no serious findings`, async ({
          browser,
        }) => {
          const { page, context } = await open(browser, c, viewport, scheme);
          await expect(page.getByRole("banner")).toBeVisible();
          // The docs viewers are third-party pages; only the frame around them is ours to audit.
          // The frame is what this file owns: header, way back, footer. The 404 and error screens are
          // frame-owned pages too, so they are audited whole. Other pages' content has its own checks.
          const builder = new AxeBuilder({ page });
          if (!c.status) {
            builder
              .include("header")
              .include("nav[aria-label=Breadcrumb]")
              .include("footer");
          }
          const { violations } = await builder.analyze();
          const serious = violations.filter(
            (v) => v.impact === "serious" || v.impact === "critical",
          );
          expect(
            serious.map(
              (v) =>
                `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
            ),
          ).toEqual([]);
          await context.close();
        });
      }
    }
  }

  test("the open phone menu has none either, in both themes", async ({
    browser,
  }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        viewport: PHONE,
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto("/privacy");
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(
        page.getByRole("navigation", { name: "Menu" }),
      ).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => v.id),
        scheme,
      ).toEqual([]);
      await context.close();
    }
  });
});

test.describe("the docs pages", () => {
  test("have the site frame and no console errors (the CSP holds)", async ({
    browser,
  }) => {
    for (const path of ["/docs", "/redoc"]) {
      const context = await browser.newContext({ viewport: DESKTOP });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.goto(path);
      await expect(page.getByRole("banner")).toBeVisible();
      await expect(page.getByRole("contentinfo")).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
          name: "Book a visit",
        }),
      ).toBeVisible();
      // Wait for the viewer to draw, then look at what the console collected.
      await expect(page.locator("#main h1, #main h2").first()).toBeVisible();
      await page.waitForTimeout(500);
      expect(errors, path).toEqual([]);
      await context.close();
    }
  });

  test("Swagger's Servers select has a name, and the page follows the theme", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: DESKTOP,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    await page.goto("/docs");
    await expect(page.getByRole("combobox", { name: "Servers" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .getByRole("button", { name: "Switch to the light theme" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await context.close();
  });

  test("ReDoc does not break its section titles mid-word on a phone", async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: PHONE });
    const page = await context.newPage();
    await page.goto("/redoc");
    const title = page.getByRole("heading", { name: "appointments" }).first();
    await expect(title).toBeVisible();
    const { lines, fits } = await title.evaluate((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return {
        lines: Math.round(el.getBoundingClientRect().height / lineHeight),
        fits: el.scrollWidth <= el.clientWidth + 1,
      };
    });
    expect(lines).toBe(1);
    expect(fits).toBe(true);
    await context.close();
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const path of ["/docs", "/redoc"]) {
      test(`${path} in ${scheme}: only the known third-party findings remain`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport: DESKTOP,
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await page.goto(path);
        await expect(page.locator("#main h1, #main h2").first()).toBeVisible();
        await page.waitForTimeout(500);
        // Left alone, and documented in the PR: Swagger's operation headers nest a button in a
        // button, its headings skip a level, and neither viewer wraps all its content in landmarks.
        // Swagger's dark theme is its light one inverted by CSS, which axe's contrast check cannot
        // see through (it reports the pre-inversion pair), so contrast is checked in light only.
        const rules = [
          "nested-interactive",
          "heading-order",
          "region",
          ...(path === "/docs" && scheme === "dark" ? ["color-contrast"] : []),
        ];
        const { violations } = await new AxeBuilder({ page })
          .disableRules(rules)
          .analyze();
        expect(
          violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => `${v.id}: ${v.nodes.length}`),
        ).toEqual([]);
        await context.close();
      });
    }
  }
});

test.describe("the footer and focus", () => {
  test("a short page keeps the footer at the bottom of a tall window", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1500 },
    });
    const page = await context.newPage();
    await page.goto("/no-such-page");
    const footer = (await page.getByRole("contentinfo").boundingBox())!;
    expect(footer.y + footer.height).toBeGreaterThanOrEqual(1499);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight,
      ),
    ).toBe(true);
    await context.close();
  });

  test("a link inside a paragraph shows the same ring the buttons do", async ({
    page,
  }) => {
    await page.goto("/privacy");
    const link = page.locator("main p a").first();
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const ring = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        shadow: s.boxShadow,
        width: s.outlineWidth,
        style: s.outlineStyle,
      };
    });
    expect(ring.shadow).not.toBe("none");
    expect(ring.style).toBe("solid");
    expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  });
});

test.describe("the pinned Confirm bar and the sticky header", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [label, viewport] of [
      ["360", { width: 360, height: 740 }],
      ["768", { width: 768, height: 900 }],
      ["1440", { width: 1440, height: 900 }],
    ] as const) {
      test(`after picking a time at ${label} in ${scheme}: the bar clears the footer and the header stays`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          viewport,
          colorScheme: scheme,
        });
        await context.addCookies(cookies);
        const page = await context.newPage();
        // A time the setup booked is gone; any other free one on the day will do. Picking one opens
        // the details page, where the pinned bar holds "Confirm booking" (nothing is booked here).
        await page.goto(`/book/${ids.doctorId}?date=${ids.day}`);
        const times = await slotsOn(ids.doctorId, ids.day);
        await page
          .getByText(hhmm(times[times.length - 1]), { exact: true })
          .click();
        const cont = page.getByRole("button", { name: "Confirm booking" });
        await expect(cont).toBeVisible();
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        const header = page.getByRole("banner");
        await expect(header).toBeInViewport({ ratio: 1 });
        expect((await header.boundingBox())!.y).toBe(0);
        // The last line of the footer sits above the bar, not under it.
        const bar = (await cont
          .locator("xpath=ancestor::*[@data-sticky-cta]")
          .boundingBox())!;
        const last = (await page
          .getByRole("contentinfo")
          .locator("p")
          .last()
          .boundingBox())!;
        expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
        // And the header and the bar never touch, even in a short window.
        expect(bar.y).toBeGreaterThan((await header.boundingBox())!.height);
        await context.close();
      });
    }
  }
});

// Loads a script, fetches a URL and loads an image from each host, in the page, and reports what the
// policy let through. Violations are collected from the browser's own securitypolicyviolation event.
async function probe(
  page: Page,
  hosts: { script?: string; connect?: string; img?: string },
) {
  return page.evaluate(async (h) => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      violations.push(`${e.effectiveDirective} ${e.blockedURI}`),
    );
    const out: Record<string, string> = {};
    if (h.script)
      out.script = await new Promise<string>((done) => {
        const s = document.createElement("script");
        s.src = h.script!;
        s.onload = () => done("loaded");
        s.onerror = () => done("blocked");
        document.head.append(s);
      });
    if (h.connect)
      out.connect = await fetch(h.connect, { mode: "no-cors" }).then(
        () => "loaded",
        () => "blocked",
      );
    if (h.img)
      out.img = await new Promise<string>((done) => {
        const i = new Image();
        i.onload = () => done("loaded");
        i.onerror = () => done("blocked");
        i.src = h.img!;
      });
    return { out, violations };
  }, hosts);
}

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("the Content-Security-Policy", () => {
  test("is sent on pages, errors and the docs, with the directives that matter", async ({
    request,
  }) => {
    for (const path of [
      "/",
      "/book",
      "/privacy",
      "/no-such-page",
      "/docs-assets/docs-shell.js",
    ]) {
      const res = await request.get(path);
      const all = res
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "content-security-policy")
        .map((h) => h.value);
      expect(all.length, path).toBeGreaterThan(0);
      const csp = all[0];
      for (const d of [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "https://lh3.googleusercontent.com",
        "https://www.google.com",
        "https://www.gstatic.com",
        "wss://realtime.ably.net",
        "https://*.ably.net",
      ])
        expect(csp, `${path}: ${d}`).toContain(d);
      expect(csp, path).not.toMatch(/script-src[^;]*\*/);
      expect(csp, path).not.toContain("unsafe-eval");
    }
    // The two docs pages keep their own, stricter policy: nothing but this origin, scripts included.
    for (const path of ["/docs", "/redoc"]) {
      const docs = (await request.get(path))
        .headersArray()
        .filter((h) => h.name.toLowerCase() === "content-security-policy");
      expect(docs, path).toHaveLength(1);
      expect(docs[0].value, path).toContain("default-src 'none'");
      expect(docs[0].value, path).toMatch(/script-src 'self'(;|$)/);
    }
  });

  test("lets reCAPTCHA, Ably and Google profile pictures through, and blocks any other host", async ({
    browser,
  }, testInfo) => {
    testInfo.annotations.push({ type: "csp-expected" });
    const context = await browser.newContext();
    await context.route("https://www.google.com/recaptcha/**", (r) =>
      r.fulfill({ contentType: "text/javascript", body: "" }),
    );
    await context.route("https://www.gstatic.com/**", (r) =>
      r.fulfill({ contentType: "image/png", body: PIXEL }),
    );
    await context.route("https://main.realtime.ably.net/**", (r) =>
      r.fulfill({ contentType: "application/json", body: "{}" }),
    );
    await context.route("https://lh3.googleusercontent.com/**", (r) =>
      r.fulfill({ contentType: "image/png", body: PIXEL }),
    );
    const page = await context.newPage();
    await page.goto("/privacy");
    const allowed = await probe(page, {
      script: "https://www.google.com/recaptcha/enterprise.js?render=k",
      connect: "https://main.realtime.ably.net/event-stream?channels=x",
      img: "https://lh3.googleusercontent.com/a/x=s96-c",
    });
    expect(allowed.out).toEqual({
      script: "loaded",
      connect: "loaded",
      img: "loaded",
    });
    expect(allowed.violations).toEqual([]);
    const blocked = await probe(page, {
      script: "https://evil.example/x.js",
      connect: "https://evil.example/collect",
      img: "https://evil.example/p.png",
    });
    expect(blocked.out).toEqual({
      script: "blocked",
      connect: "blocked",
      img: "blocked",
    });
    expect(blocked.violations).toHaveLength(3);
    await context.close();
  });

  test("keeps the docs pages working under it", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/docs");
    await expect(page.getByRole("combobox", { name: "Servers" })).toBeVisible();
    await page.goto("/redoc");
    await expect(
      page.getByRole("heading", { name: "appointments" }).first(),
    ).toBeVisible();
    await context.close();
  });
});
