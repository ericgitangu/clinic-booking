import { expect, test, type Page } from "@playwright/test";
import { newPerson, sessionCookies } from "./support/auth";

// Real production build, real browser, real service worker. Only the static shell may ever be in
// Cache Storage: no /api, /auth or server-action response, and no page (signed in or not).

type CacheDump = { cache: string; url: string; body: string }[];

async function dumpCaches(page: Page): Promise<CacheDump> {
  return page.evaluate(async () => {
    const out: { cache: string; url: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = await cache.match(req);
        out.push({
          cache: name,
          url: req.url,
          body: (await res?.text()) ?? "",
        });
      }
    }
    return out;
  });
}

async function controlled(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  // clientsClaim takes control of this page; wait for it before reloading through the worker.
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
}

test("after one visit the shell reloads offline, and only the shell is cached", async ({
  browser,
}) => {
  const person = newPerson();
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  const page = await context.newPage();

  await page.goto("/");
  await controlled(page);

  // Everything below runs through the worker: a page, a personal page, API reads and a POST.
  await page.reload();
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const apiStatus = await page.evaluate(async () => {
    const doctors = await fetch("/api/doctors");
    const me = await fetch("/api/doctors", { method: "POST", body: "{}" });
    return [doctors.status, me.status];
  });
  expect(apiStatus[0]).toBe(200);

  // The static files the page loaded are cached by the worker.
  await expect
    .poll(
      async () =>
        (await dumpCaches(page)).filter((e) =>
          new URL(e.url).pathname.startsWith("/_next/static/"),
        ).length,
    )
    .toBeGreaterThan(0);

  // Install precaches the offline page; wait for it rather than assume the order of events.
  await expect
    .poll(async () =>
      (await dumpCaches(page)).some(
        (e) => new URL(e.url).pathname === "/offline.html",
      ),
    )
    .toBe(true);
  const entries = await dumpCaches(page);
  const allowed = /^\/(_next\/static\/|brand\/|offline\.html$)/;
  for (const e of entries) {
    const u = new URL(e.url);
    expect(u.origin, e.url).toBe("http://localhost:3100");
    expect(u.pathname, e.url).toMatch(allowed);
    // Serwist tags precached public files with their revision; nothing else carries a query.
    expect(u.search, e.url).toMatch(/^(|\?__WB_REVISION__=[0-9a-f]+)$/);
    expect(e.body).not.toContain(person.email);
    expect(e.body).not.toContain(person.name);
  }

  // Offline: a reload lands on the offline page, the cached static files are still served, and an
  // API call fails instead of being answered from a cache.
  const cachedStatic = entries.find((e) =>
    e.url.includes("/_next/static/"),
  )!.url;
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You are offline" }),
  ).toBeVisible();
  const offline = await page.evaluate(async (staticUrl) => {
    const cached = await fetch(staticUrl).then(
      (r) => r.status,
      () => -1,
    );
    const api = await fetch("/api/doctors").then(
      (r) => r.status,
      () => -1,
    );
    const apiPost = await fetch("/api/doctors", { method: "POST" }).then(
      (r) => r.status,
      () => -1,
    );
    return { cached, api, apiPost };
  }, cachedStatic);
  expect(offline).toEqual({ cached: 200, api: -1, apiPost: -1 });

  await context.setOffline(false);
  await context.close();
});

test("a signed-in visit leaves no personal page in the cache", async ({
  browser,
}) => {
  const person = newPerson();
  const context = await browser.newContext();
  await context.addCookies(await sessionCookies(person));
  const page = await context.newPage();
  await page.goto("/");
  await controlled(page);
  for (const path of ["/book", "/appointments", "/about"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  for (const e of await dumpCaches(page)) {
    const path = new URL(e.url).pathname;
    expect(["/book", "/appointments", "/about", "/"]).not.toContain(path);
    expect(e.body).not.toContain(person.email);
  }
  await context.close();
});
