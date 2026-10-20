import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrail } from "@clinic/ui/lib/shell-trail";
import { FOOTER_COLUMNS } from "@/lib/footer-links";
import { SHELL_ROUTES } from "@/lib/shell-routes";
import { NAV_LINKS } from "@/components/layout/nav-links";

// Targets that are data, not pages: no header, footer or trail is drawn on them.
const NOT_A_PAGE = new Set(["/openapi.json"]);

const APP_DIR = join(__dirname, "../../src/app");

// Every page.tsx under src/app as a route pattern: "(group)" folders vanish, "[id]" becomes ":id".
function pagePatterns(dir = APP_DIR, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      const seg = /^\(.*\)$/.test(name)
        ? ""
        : `/${name.replace(/^\[(.+)\]$/, ":$1")}`;
      out.push(...pagePatterns(full, base + seg));
    } else if (name === "page.tsx") {
      out.push(base || "/");
    }
  }
  return out;
}

const hrefPath = (href: string) => href.split(/[?#]/, 1)[0] as string;
const labelAt = (path: string) =>
  resolveTrail(path, SHELL_ROUTES).crumbs.at(-1)?.label;

describe("every page the patient app serves has a breadcrumb label", () => {
  const navPaths = NAV_LINKS.map((l) => hrefPath(l.href));
  const footerPaths = FOOTER_COLUMNS.flatMap((c) => c.links)
    .filter((l) => !l.external)
    .map((l) => hrefPath(l.href));
  const pagePaths = pagePatterns().map((p) => p.replace(/:[^/]+/g, "x"));

  const all = [...new Set([...navPaths, ...footerPaths, ...pagePaths])]
    .filter((p) => !NOT_A_PAGE.has(p))
    .sort();

  it("finds the routes it is meant to check", () => {
    expect(pagePaths).toEqual(
      expect.arrayContaining(["/", "/book", "/decisions", "/appointments"]),
    );
    expect(navPaths).toContain("/decisions");
    expect(footerPaths).toContain("/decisions");
  });

  it.each(all)("%s", (path) => {
    expect(labelAt(path)).not.toBe(SHELL_ROUTES.unknownLabel);
  });

  it("reads Home > Decisions on the decisions page", () => {
    expect(
      resolveTrail("/decisions", SHELL_ROUTES).crumbs.map((c) => c.label),
    ).toEqual(["Home", "Decisions"]);
  });
});
