import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as openapiRoute from "@/app/openapi.json/route";
import * as docsRoute from "@/app/docs/route";
import * as redocRoute from "@/app/redoc/route";
import { resolveUpstream } from "@clinic/api/proxy/forward";

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
    expect(html).toContain("/docs-assets/swagger-init.js");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("/api/openapi.json, /api/docs, /api/redoc redirect to the static root routes", () => {
    for (const p of ["openapi.json", "docs", "redoc"]) {
      expect(resolveUpstream([p])).toEqual({ kind: "redirect", to: `/${p}` });
    }
  });

  it("the doc pages load only from this origin and say so in a CSP", async () => {
    for (const route of [docsRoute, redocRoute]) {
      const res = await route.GET();
      const html = await res.text();
      // No absolute URL in any src/href that loads something: the bundles are the pinned npm
      // packages, copied to /docs-assets. Plain links (the site frame's navigation) may be absolute.
      const loads = [
        ...html.matchAll(/<(?:script|link|img)\b[^>]*?(?:src|href)="([^"]+)"/g),
      ].map((m) => m[1] as string);
      expect(loads.length).toBeGreaterThan(0);
      for (const l of loads) {
        expect(l).not.toMatch(/^(?:https?:)?\/\//);
        // Same-origin files only: the vendored bundles, the frame's own files, the logo and icon.
        expect(l).toMatch(/^\/(?:docs-assets\/|brand\/|favicon\.ico$)/);
      }
      expect(loads.some((l) => l.startsWith("/docs-assets/"))).toBe(true);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).not.toMatch(/https?:|\*/);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-/);
    }
  });

  it("the Swagger starter is a committed file that keeps deep links on", () => {
    const init = readFileSync(
      resolve(__dirname, "../../public/docs-assets/swagger-init.js"),
      "utf8",
    );
    expect(init).toContain("deepLinking: true");
    expect(init).toContain('url: "/openapi.json"');
  });
});
