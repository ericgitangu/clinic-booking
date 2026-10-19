import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { expectFree, expectInactive } from "./support/chips";
import { farCell } from "./support/cells";
import { newPerson, sessionCookies } from "./support/auth";

// Live updates over the push service, with the real API and database. In CI the service is the real
// one (the `ably-ci` context key reaches the API); on a machine with no key, E2E_PUSH_LOCAL=1 starts
// a local stand-in for that third party (support/fake-push.mjs) and the API is pointed at it. The
// safety-net poll is 60 s while the stream is live, so a change that shows up in a second or two
// came from the push, not from polling. Instance = 100 + repeat * 8 + scenario owns calendar cell
// (support/cells.ts farCell), after the cells the double-booking spec uses.
test.skip(
  !process.env.ABLY_API_KEY && !process.env.E2E_PUSH_LOCAL,
  "needs ABLY_API_KEY (CI, ably-ci context) or E2E_PUSH_LOCAL=1 for the local stand-in",
);
const LOCAL = !!process.env.E2E_PUSH_LOCAL;
const cellOf = (scenario: number, repeat: number) =>
  100 + repeat * 8 + scenario;

let nextIp = 0;
const ip = () =>
  `10.${test.info().workerIndex % 256}.${(Math.floor(nextIp / 250) % 100) + 150}.${(nextIp++ % 250) + 1}`;

const grid = (doctorId: string, day: string) => `/book/${doctorId}?date=${day}`;
const details = (doctorId: string, startsAt: string) =>
  `/book/${doctorId}/details?starts_at=${encodeURIComponent(startsAt)}`;
const marker = (page: Page) => page.locator("[data-stream]");

// Each context announces its own client address to the app's /api proxy, as the edge would. Only
// same-origin /api requests carry it: a header added to every request (extraHTTPHeaders) would
// also reach the push service and turn its stream request into a CORS preflight it refuses.
async function withAddress(context: BrowserContext, address: string) {
  await context.route(/localhost:3100\/api\//, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-forwarded-for": address },
    }),
  );
}

async function viewer(browser: Browser) {
  const context = await browser.newContext();
  await withAddress(context, ip());
  return { context, page: await context.newPage() };
}

async function patient(browser: Browser) {
  const context = await browser.newContext();
  await withAddress(context, ip());
  await context.addCookies(await sessionCookies(newPerson()));
  return { context, page: await context.newPage() };
}

async function bookOn(page: Page, doctorId: string, startsAt: string) {
  await page.goto(details(doctorId, startsAt));
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(
    page.getByRole("heading", { name: "You are booked" }),
  ).toBeVisible();
}

async function cancelFirst(page: Page) {
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Why are you cancelling?").fill("changed my mind");
  await page.getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Nothing booked.")).toBeVisible();
}

const isAvailability = (url: string) =>
  url.includes("/api/doctors/") && url.includes("/availability");

// `seen` counts availability requests; `settled()` waits until every one of them has finished. A
// reply that lands after the driven clock has jumped re-arms the poll timer at the later time, so
// the scenarios that drive the clock wait for in-flight requests first.
const availabilityCalls = (page: Page) => {
  const seen: string[] = [];
  const done: string[] = [];
  page.on("request", (r) => isAvailability(r.url()) && seen.push(r.url()));
  const finished = (r: { url(): string }) =>
    isAvailability(r.url()) && done.push(r.url());
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  return Object.assign(seen, {
    settled: () => expect.poll(() => seen.length - done.length).toBe(0),
  });
};

async function closeAll(...c: BrowserContext[]) {
  for (const x of c) await x.close();
}

test("(a) a time another person books turns inactive in under two seconds, by push", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(0, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  const calls = availabilityCalls(a.page);
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-stream", "live");
  await expect.poll(() => calls.length).toBe(1); // the one refetch after connecting
  await expectFree(a.page, slots[1]);

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);

  await expectInactive(a.page, slots[1], /Just taken/, { timeout: 2000 });
  expect(calls).toHaveLength(1); // no poll was needed
  await closeAll(a.context, b.context);
});

test("(b) a cancellation frees the time after one refetch", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(1, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  const calls = availabilityCalls(a.page);
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-stream", "live");
  await expect.poll(() => calls.length).toBe(1);

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);
  await expectInactive(a.page, slots[1], undefined, {
    timeout: 2000,
  });
  const before = calls.length;

  await cancelFirst(b.page);
  await expectFree(a.page, slots[1], {
    timeout: 3000,
  });
  expect(calls.length - before).toBe(1); // one refetch, not a poll
  await closeAll(a.context, b.context);
});

test("(c) with the push service unreachable the page says polling and still converges", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(2, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  await a.context.route(/localhost:3199|ably\.net/, (r) => r.abort());
  await a.page.clock.install();
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-polling", "armed");
  await a.page.clock.runFor(1000);
  await expect(marker(a.page)).toHaveAttribute("data-stream", "polling");

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);
  await a.page.clock.runFor(16_000); // one 15 s poll
  await expectInactive(a.page, slots[1], undefined);
  await closeAll(a.context, b.context);
});

test("(d) a rate-limited token endpoint is refused, and the page keeps polling", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(3, testInfo.repeatEachIndex),
  );
  const address = ip();
  const context = await browser.newContext();
  await withAddress(context, address);
  const a = { context, page: await context.newPage() };
  // Use up this address's allowance at the real token endpoint.
  let limited = false;
  for (let i = 0; i < 200 && !limited; i++) {
    const r = await a.context.request.post("/api/realtime/token/patient", {
      data: { doctor_id: doctorId, date: day },
      headers: { origin: "http://localhost:3100", "x-forwarded-for": address },
    });
    limited = r.status() === 429;
  }
  expect(limited).toBe(true);

  await a.page.clock.install();
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-polling", "armed");
  await a.page.clock.runFor(1000);
  await expect(marker(a.page)).toHaveAttribute("data-stream", "refused");

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);
  await a.page.clock.runFor(16_000);
  await expectInactive(a.page, slots[1], undefined);
  await closeAll(a.context, b.context);
});

test("(f) an unchanged poll renders the grid zero times, one event renders it once", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(5, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  const calls = availabilityCalls(a.page);
  await a.page.clock.install();
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-stream", "live");
  await expect.poll(() => calls.length).toBe(1);
  await calls.settled();
  const field = a.page.locator("fieldset[data-renders]");
  await expect(field).toBeVisible();
  const renders = async () => Number(await field.getAttribute("data-renders"));
  const settled = await renders();

  await a.page.clock.runFor(61_000); // the 60 s safety-net poll while live
  await expect.poll(() => calls.length).toBe(2);
  await calls.settled();
  await a.page.waitForTimeout(300);
  expect(await renders()).toBe(settled);
  // The 61 s jump fires every timer the page had pending. The push stream must still be the live
  // one before the event is sent: if it was dropped here, a missed event would look like a render
  // bug, and the fake clock means no poll could cover for it.
  await expect(
    marker(a.page),
    "the push stream must still be live after the clock jump",
  ).toHaveAttribute("data-stream", "live");

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);
  try {
    await expectInactive(a.page, slots[1], undefined);
  } catch (e) {
    // Say what the page believed when the event did not arrive (CI keeps no browser artifacts).
    const stream = await marker(a.page).getAttribute("data-stream");
    throw new Error(
      `the pushed event was not applied; data-stream=${stream}, availability calls=${calls.length}\n${String(e)}`,
    );
  }
  expect(await renders()).toBe(settled + 1);
  await closeAll(a.context, b.context);
});

test("(g) the same message delivered twice changes the page once", async ({
  browser,
}, testInfo) => {
  test.skip(
    !LOCAL,
    "the real service drops a repeated id itself; the rule is unit-tested",
  );
  const { doctorId, day, slots } = await farCell(
    cellOf(6, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  await a.page.goto(grid(doctorId, day));
  await expect(marker(a.page)).toHaveAttribute("data-stream", "live");
  const field = a.page.locator("fieldset[data-renders]");

  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]);
  await expectInactive(a.page, slots[1], undefined);
  const after = Number(await field.getAttribute("data-renders"));

  const channel = `slots:${doctorId}:${day}`;
  const stats = await (await fetch("http://localhost:3199/__stats")).json();
  expect(stats.published).toBeGreaterThan(0);
  // Re-deliver every message the stand-in kept for this channel (a relay re-run).
  for (let n = 0; n < 5; n++) {
    await fetch("http://localhost:3199/__redeliver", {
      method: "POST",
      body: JSON.stringify({ channel, id: await lastId(channel) }),
    });
  }
  await a.page.waitForTimeout(300);
  expect(Number(await field.getAttribute("data-renders"))).toBe(after);
  await closeAll(a.context, b.context);
});

async function lastId(channel: string): Promise<string> {
  // The stand-in numbers nothing itself: the id is the event's "<txid>.<id>.<part>". Read it from
  // the stand-in's own record rather than guessing.
  const r = await fetch(
    `http://localhost:3199/__last?channel=${encodeURIComponent(channel)}`,
  );
  return (await r.json()).id as string;
}

test("(h) a patient token cannot read the admin channel", async ({
  browser,
}, testInfo) => {
  const { doctorId, day, slots } = await farCell(
    cellOf(7, testInfo.repeatEachIndex),
  );
  const a = await viewer(browser);
  const res = await a.context.request.post("/api/realtime/token/patient", {
    data: { doctor_id: doctorId, date: day },
    headers: { origin: "http://localhost:3100", "x-forwarded-for": ip() },
  });
  expect(res.status()).toBe(200);
  const t = (await res.json()) as {
    token: string;
    stream_url: string;
    channel: string;
  };

  // The token's capability names exactly one channel, subscribe only.
  const claims = JSON.parse(
    Buffer.from(t.token.split(".")[1], "base64url").toString(),
  ) as Record<string, string>;
  expect(JSON.parse(claims["x-ably-capability"])).toEqual({
    [`slots:${doctorId}:${day}`]: ["subscribe"],
  });
  expect(t.channel).toBe(`slots:${doctorId}:${day}`);

  // Asking the service for the admin channel with it: whatever the service does with the stream
  // (an error frame, or silence), no message may arrive, even while an admin event is published.
  const url = new URL(t.stream_url);
  url.searchParams.set("channels", "admin:events");
  const abort = new AbortController();
  const stop = setTimeout(() => abort.abort(), 6000);
  const seen: string[] = [];
  const reading = (async () => {
    try {
      const stream = await fetch(url, {
        headers: { Authorization: `Bearer ${t.token}` },
        signal: abort.signal,
      });
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* aborted at the end of the observation window */
    }
  })();
  const b = await patient(browser);
  await bookOn(b.page, doctorId, slots[1]); // publishes to admin:events as well
  await reading;
  clearTimeout(stop);
  const text = seen.join("");
  expect(text).not.toContain("event: message");
  expect(text).not.toContain("booked"); // the admin event's name
  await closeAll(a.context, b.context);
});

test("(e) React StrictMode's double mount in development mints one push token, not two", async ({
  browser,
}, testInfo) => {
  const { doctorId, day } = await farCell(cellOf(4, testInfo.repeatEachIndex));
  const context = await browser.newContext({
    baseURL: "http://localhost:3101",
  });
  await context.route(/localhost:3101\/api\//, (route) =>
    route.continue({
      headers: { ...route.request().headers(), "x-forwarded-for": ip() },
    }),
  );
  const page = await context.newPage();
  let mints = 0;
  page.on(
    "request",
    (r) =>
      r.method() === "POST" &&
      r.url().includes("/api/realtime/token/patient") &&
      mints++,
  );
  await page.goto(`http://localhost:3101${grid(doctorId, day)}`);
  // (The API only mints for the production build's origin, so the stream itself may be refused
  // here; what matters is how many tokens were asked for.)
  await expect(marker(page)).toHaveAttribute("data-polling", "armed", {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  expect(mints).toBe(1);
  await context.close();
});
