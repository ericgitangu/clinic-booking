import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "@/proxy";

// next.config.ts cannot be imported here (it wires the service worker), so its list is read as text.
const HASHED_PAGES: readonly string[] = (() => {
  const src = readFileSync(join(__dirname, "../../next.config.ts"), "utf8");
  const list = /const HASHED_PAGES = \[([^\]]*)\] as const/.exec(src)?.[1];
  if (list === undefined)
    throw new Error("HASHED_PAGES not found in next.config.ts");
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
})();

const APP_DIR = join(__dirname, "../../src/app");

// Every page.tsx under src/app: its first URL segment ("" for the home page) and its source.
function pages(
  dir = APP_DIR,
  segs: string[] = [],
): { top: string; src: string }[] {
  const out: { top: string; src: string }[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...pages(full, /^\(.*\)$/.test(name) ? segs : [...segs, name]));
    } else if (name === "page.tsx") {
      out.push({ top: segs[0] ?? "", src: readFileSync(full, "utf8") });
    }
  }
  return out;
}

// The routes the proxy gives a per-request nonce: the plain-string matchers ("/book/:path*" -> "book").
const NONCE_TOPS = new Set(
  config.matcher
    .filter((m): m is string => typeof m === "string")
    .map((m) => m.split("/")[1]?.replace(/:.*$/, "") ?? ""),
);

describe("every page has a Content-Security-Policy that fits how it is rendered", () => {
  const all = pages();

  it("reads the list", () => {
    expect(HASHED_PAGES).toContain("about");
  });

  it("finds the pages", () => {
    expect(all.length).toBeGreaterThan(8);
    expect(all.map((p) => p.top)).toContain("decisions");
  });

  it.each(all.map((p) => [p.top || "/", p] as const))("%s", (_name, p) => {
    const dynamic = /export const dynamic = "force-dynamic"/.test(p.src);
    if (dynamic) {
      // Rendered per request: the proxy must hand it a nonce.
      expect(
        NONCE_TOPS.has(p.top),
        `${p.top} is not in the proxy matcher`,
      ).toBe(true);
    } else {
      // Built once: it needs its hashed policy, or its inline scripts are blocked.
      expect(
        HASHED_PAGES.includes(p.top),
        `${p.top} is built once but is not in HASHED_PAGES (next.config.ts)`,
      ).toBe(true);
    }
  });

  it("lists no page that does not exist", () => {
    const tops = new Set(all.map((p) => p.top));
    for (const name of HASHED_PAGES) expect(tops.has(name), name).toBe(true);
  });
});
