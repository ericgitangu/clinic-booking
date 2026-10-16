import { describe, expect, it, vi } from "vitest";
import * as openapiRoute from "@/app/openapi.json/route";
import * as docsRoute from "@/app/docs/route";
import * as redocRoute from "@/app/redoc/route";
import { resolveUpstream } from "@/lib/proxy/forward";

describe("doc routes are static and never fetch upstream", () => {
  it("all three are force-static", () => {
    expect(openapiRoute.dynamic).toBe("force-static");
    expect(docsRoute.dynamic).toBe("force-static");
    expect(redocRoute.dynamic).toBe("force-static");
  });

  it("/openapi.json returns the snapshot with servers[0].url == /api and makes no fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await openapiRoute.GET();
    const body = (await res.json()) as {
      servers: { url: string }[];
      info: { title: string };
    };
    expect(body.servers[0].url).toBe("/api");
    expect(body.info.title).toBe("Clinic Booking API");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("/docs references /openapi.json and makes no fetch", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await docsRoute.GET();
    const html = await res.text();
    expect(html).toContain('url: "/openapi.json"');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("/api/openapi.json, /api/docs, /api/redoc redirect to the static root routes", () => {
    for (const p of ["openapi.json", "docs", "redoc"]) {
      expect(resolveUpstream([p])).toEqual({ kind: "redirect", to: `/${p}` });
    }
  });

  it("every CDN asset on the doc pages carries a SHA-384 integrity hash", async () => {
    for (const route of [docsRoute, redocRoute]) {
      const html = await (await route.GET()).text();
      const tags =
        html.match(
          /<(?:script|link)[^>]+https:\/\/cdn\.jsdelivr\.net[^>]*>/g,
        ) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag).toMatch(/integrity="sha384-[A-Za-z0-9+/]{64}"/);
        expect(tag).toContain('crossorigin="anonymous"');
      }
    }
  });
});
