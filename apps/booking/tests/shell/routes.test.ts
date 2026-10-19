import { describe, expect, it } from "vitest";
import { activeHref } from "@clinic/ui/lib/nav";
import { checkRoutes, resolveTrail } from "@clinic/ui/lib/shell-trail";
import { NAV_LINKS } from "@/components/layout/nav-links";
import { SHELL_ROUTES } from "@/lib/shell-routes";

const DOCTOR = "3f2b1c9e-0d4a-4a52-9b0e-1f6c7a8d9e01";
const APPT = "7c1e5b2a-9d3f-4e68-8a14-2b5d6c7e8f90";

describe("booking route list", () => {
  it("is internally consistent", () => {
    expect(checkRoutes(SHELL_ROUTES)).toEqual([]);
  });

  // path, parent href, parent label: the table the e2e test walks in a real browser
  const cases: [string, string | null, string | null][] = [
    ["/", null, null],
    ["/book", "/", "Home"],
    [`/book/${DOCTOR}`, "/book", "Book a visit"],
    [`/book/${DOCTOR}/details`, `/book/${DOCTOR}`, "Choose a time"],
    [`/book/confirmed/${APPT}`, "/appointments", "My appointments"],
    ["/appointments", "/", "Home"],
    [`/appointments/${APPT}`, "/appointments", "My appointments"],
    [`/appointments/${APPT}/reschedule`, "/appointments", "My appointments"],
    ["/about", "/", "Home"],
    ["/privacy", "/", "Home"],
    ["/terms", "/", "Home"],
    ["/data", "/", "Home"],
    ["/docs", "/", "Home"],
    ["/redoc", "/", "Home"],
    ["/no/such/page", "/", "Home"],
  ];
  it.each(cases)("%s goes back to %s", (path, href, label) => {
    const { parent } = resolveTrail(path, SHELL_ROUTES);
    expect(parent?.href ?? null).toBe(href);
    expect(parent?.label ?? null).toBe(label);
  });

  it("ends the trail on the current page, root first", () => {
    const { crumbs } = resolveTrail(`/book/${DOCTOR}/details`, SHELL_ROUTES);
    expect(crumbs.map((c) => c.href)).toEqual([
      "/",
      "/book",
      `/book/${DOCTOR}`,
      `/book/${DOCTOR}/details`,
    ]);
  });

  it("prefers the static route over a dynamic one of the same shape", () => {
    // "/book/confirmed/x" has the same length as "/book/:doctorId/details" but is its own page.
    const { crumbs } = resolveTrail(`/book/confirmed/${APPT}`, SHELL_ROUTES);
    expect(crumbs.at(-1)?.label).toBe("Booking confirmed");
  });

  it("ignores a trailing slash, a query and a hash", () => {
    const a = resolveTrail("/book/?x=1#top", SHELL_ROUTES);
    expect(a.crumbs.at(-1)?.label).toBe("Book a visit");
  });

  it("labels an unknown path as not found, with a way home", () => {
    const { crumbs, parent } = resolveTrail("/nope", SHELL_ROUTES);
    expect(crumbs.at(-1)).toMatchObject({
      href: "/nope",
      label: "Page not found",
    });
    expect(parent).toMatchObject({ href: "/", label: "Home" });
  });

  it("treats a missing pathname as the root", () => {
    expect(resolveTrail(null, SHELL_ROUTES).parent).toBeNull();
  });
});

describe("active nav item", () => {
  it("is the section a page belongs to", () => {
    expect(activeHref(NAV_LINKS, "/book")).toBe("/book");
    expect(activeHref(NAV_LINKS, `/book/${DOCTOR}/details`)).toBe("/book");
    expect(activeHref(NAV_LINKS, "/appointments")).toBe("/appointments");
  });
  it("is nothing on pages outside the nav, the 404 included", () => {
    expect(activeHref(NAV_LINKS, "/")).toBeNull();
    expect(activeHref(NAV_LINKS, "/privacy")).toBeNull();
    expect(activeHref(NAV_LINKS, "/nope")).toBeNull();
    expect(activeHref(NAV_LINKS, null)).toBeNull();
  });
  it("does not match a path that merely starts with the same letters", () => {
    expect(activeHref(NAV_LINKS, "/booking")).toBeNull();
  });
});

describe("what a back link says", () => {
  it.each([
    ["/book", "Back to home"],
    [`/book/${DOCTOR}`, "Back to doctors"],
    [`/book/${DOCTOR}/details`, "Back to times"],
    [`/book/confirmed/${APPT}`, "Back to my appointments"],
    [`/appointments/${APPT}`, "Back to my appointments"],
    ["/nope", "Back to home"],
  ])("%s says %s", (path, text) => {
    expect(
      `Back to ${resolveTrail(path, SHELL_ROUTES).parent?.backLabel}`,
    ).toBe(text);
  });
  it("never starts a label with a capital after 'Back to'", () => {
    for (const r of SHELL_ROUTES.routes) {
      const label =
        r.backLabel ?? r.label.charAt(0).toLowerCase() + r.label.slice(1);
      expect(label, r.pattern).toMatch(/^[a-z]/);
    }
  });
});
