import { describe, expect, it } from "vitest";
import {
  checkRoutes,
  fillPattern,
  matchPattern,
  normalizePath,
  resolveTrail,
  type ShellRoutes,
} from "@clinic/ui/lib/shell-trail";

const cfg: ShellRoutes = {
  fallbackParent: "/",
  unknownLabel: "Not found",
  routes: [
    { pattern: "/", label: "Home" },
    { pattern: "/a", label: "A", parent: "/" },
    { pattern: "/a/:id", label: "One", parent: "/a" },
    { pattern: "/a/:id/edit", label: "Edit", parent: "/a/:id" },
  ],
};

describe("patterns", () => {
  it("matches one segment per :name and nothing else", () => {
    expect(matchPattern("/a/:id", "/a/7")).toEqual({ id: "7" });
    expect(matchPattern("/a/:id", "/a")).toBeNull();
    expect(matchPattern("/a/:id", "/a/7/x")).toBeNull();
    expect(matchPattern("/", "/")).toEqual({});
  });
  it("fills names back in, or says it cannot", () => {
    expect(fillPattern("/a/:id", { id: "7" })).toBe("/a/7");
    expect(fillPattern("/a/:id", {})).toBeNull();
    expect(fillPattern("/", {})).toBe("/");
  });
  it("normalises paths", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/a/")).toBe("/a");
    expect(normalizePath("/a?x=1")).toBe("/a");
    expect(normalizePath("a")).toBe("/a");
  });
});

describe("resolveTrail", () => {
  it("gives a root page no parent", () => {
    expect(resolveTrail("/", cfg)).toEqual({
      crumbs: [{ href: "/", label: "Home", backLabel: "home" }],
      parent: null,
    });
  });
  it("fills the parent's names from the child's path", () => {
    expect(resolveTrail("/a/9/edit", cfg).parent).toEqual({
      href: "/a/9",
      label: "One",
      backLabel: "one",
    });
  });
  it("falls back to the fallback parent for an unknown path", () => {
    expect(resolveTrail("/zzz", cfg).parent).toEqual({
      href: "/",
      label: "Home",
      backLabel: "home",
    });
  });
});

describe("checkRoutes", () => {
  it("accepts a good list", () => {
    expect(checkRoutes(cfg)).toEqual([]);
  });
  it("reports a parent that is not a route", () => {
    const bad = {
      ...cfg,
      routes: [...cfg.routes, { pattern: "/b", label: "B", parent: "/nope" }],
    };
    expect(checkRoutes(bad).join()).toContain("not a route");
  });
  it("reports a parent that needs a name the child lacks", () => {
    const bad = {
      ...cfg,
      routes: [...cfg.routes, { pattern: "/c", label: "C", parent: "/a/:id" }],
    };
    expect(checkRoutes(bad).join()).toContain("lacks");
  });
  it("reports a loop and does not hang resolving it", () => {
    const loop: ShellRoutes = {
      ...cfg,
      routes: [
        { pattern: "/", label: "Home" },
        { pattern: "/x", label: "X", parent: "/y" },
        { pattern: "/y", label: "Y", parent: "/x" },
      ],
    };
    expect(checkRoutes(loop).join()).toContain("loops");
    expect(resolveTrail("/x", loop).crumbs.length).toBeLessThanOrEqual(3);
  });
});
