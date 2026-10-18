import { beforeEach, describe, expect, it, vi } from "vitest";

const listDoctors = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ listDoctors }));

import sitemap from "@/app/sitemap";
import { PUBLIC_PATHS, SITE } from "@/lib/site";

beforeEach(() => listDoctors.mockReset());

describe("sitemap", () => {
  it("adds a page for each doctor the API lists", async () => {
    listDoctors.mockResolvedValue({
      ok: true,
      data: { items: [{ id: "d-1" }, { id: "d-2" }] },
    });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        `${SITE.url}/book/d-1`,
        `${SITE.url}/book/d-2`,
        `${SITE.url}/book`,
      ]),
    );
    expect(urls).toHaveLength(PUBLIC_PATHS.length + 2);
  });

  it("still answers with the fixed pages when the API is down", async () => {
    listDoctors.mockResolvedValue({
      ok: false,
      kind: "unavailable",
      status: 503,
      code: "UPSTREAM_UNAVAILABLE",
    });
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toHaveLength(PUBLIC_PATHS.length);
    expect(urls[0]).toBe(SITE.url);
  });

  it("lists every address once, all on the site's own host", async () => {
    listDoctors.mockResolvedValue({ ok: true, data: { items: [] } });
    const urls = (await sitemap()).map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(u.startsWith(SITE.url)).toBe(true);
  });
});
