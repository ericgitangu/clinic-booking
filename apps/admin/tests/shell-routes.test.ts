import { describe, expect, it } from "vitest";
import { checkRoutes, resolveTrail } from "@clinic/ui/lib/shell-trail";
import { SHELL_ROUTES } from "@/lib/shell-routes";

const ID = "7c1e5b2a-9d3f-4e68-8a14-2b5d6c7e8f90";

describe("admin route list", () => {
  it("is internally consistent", () => {
    expect(checkRoutes(SHELL_ROUTES)).toEqual([]);
  });

  const cases: [string, string | null][] = [
    ["/", null],
    ["/dashboard", null],
    ["/access", "/dashboard"],
    ["/audit", "/dashboard"],
    ["/dashboard/print", "/dashboard"],
    ["/invite/abc123", "/"],
    [`/dashboard/appointments/${ID}`, "/dashboard"],
    ["/no/such/page", "/dashboard"],
  ];
  it.each(cases)("%s goes back to %s", (path, href) => {
    expect(resolveTrail(path, SHELL_ROUTES).parent?.href ?? null).toBe(href);
  });
});

describe("what a back link says", () => {
  it("is sentence case", () => {
    expect(resolveTrail("/access", SHELL_ROUTES).parent?.backLabel).toBe(
      "dashboard",
    );
    expect(resolveTrail("/nope", SHELL_ROUTES).parent?.backLabel).toBe(
      "dashboard",
    );
  });
});
