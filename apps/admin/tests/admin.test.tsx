import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Dashboard from "@/app/dashboard/page";
import SignInGate from "@/app/page";
import robots from "@/app/robots";
import { metadata } from "@/lib/metadata";
import { SITE } from "@/lib/site";

describe("admin app", () => {
  it("shows one h1 and a sign-in button that is disabled until sign-in exists", () => {
    const html = renderToStaticMarkup(<SignInGate />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(SITE.name);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("has a dashboard frame with no data", () => {
    const html = renderToStaticMarkup(<Dashboard />);
    expect(html).toContain("Nothing to show yet");
  });

  it("keeps crawlers out", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
