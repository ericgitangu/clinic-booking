import { expect, test } from "@playwright/test";

// The name is "Idyllic Clinic" everywhere a person or a crawler can read it. Every public page, the
// manifest, the sitemap and the API's doctor list are fetched from the running stack and must contain
// neither the old product name nor the seed's old clinic name. (The gatekeeper runs the same count on
// production: the same count must be 0.)
// Built from parts so this file does not itself contain the banned phrase.
const OLD = new RegExp(
  ["mv" + "ule", "idyllic clinic " + "booking"].join("|"),
  "i",
);

const PAGES = [
  "/",
  "/book",
  "/about",
  "/privacy",
  "/terms",
  "/data",
  "/docs",
  "/redoc",
  "/appointments",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/openapi.json",
  "/api/doctors",
];

test("no page, the manifest or the doctor list carries the old name", async ({
  request,
}) => {
  const doctors = (await (await request.get("/api/doctors")).json()) as {
    items: { id: string }[];
  };
  const urls = [...PAGES, ...doctors.items.map((d) => `/book/${d.id}`)];
  for (const url of urls) {
    const res = await request.get(url);
    expect(res.status(), url).toBeLessThan(400);
    const body = await res.text();
    expect(body.match(OLD), `${url} contains the old name`).toBeNull();
  }
});

test('the title of every page reads "<Page> | Idyllic Clinic", and the share card says the same', async ({
  page,
}) => {
  for (const url of ["/", "/book", "/about", "/privacy", "/terms", "/data"]) {
    await page.goto(url);
    await expect(page, url).toHaveTitle(
      /^(Idyllic Clinic|.+ \| Idyllic Clinic)$/,
    );
    const og = (sel: string) =>
      page.locator(sel).first().getAttribute("content");
    expect(await og('meta[property="og:title"]'), url).toMatch(
      /^(Idyllic Clinic|.+ \| Idyllic Clinic)$/,
    );
    expect(await og('meta[property="og:image:alt"]'), url).toContain(
      "Idyllic Clinic",
    );
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Idyllic Clinic",
  );
  await expect(page.getByRole("banner")).toContainText("Idyllic Clinic");

  const manifest = (await (
    await page.request.get("/manifest.webmanifest")
  ).json()) as { name: string; short_name: string };
  expect(manifest.name).toBe("Idyllic Clinic");
  expect(manifest.short_name).not.toMatch(OLD);
});
