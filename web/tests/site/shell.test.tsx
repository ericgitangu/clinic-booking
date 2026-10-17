import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import { PageShell } from "@/components/layout/page-shell";
import {
  RECAPTCHA_ATTRIBUTION,
  SiteFooter,
} from "@/components/layout/site-footer";

describe("page shell", () => {
  it("offers a skip link to a single main landmark", () => {
    const html = renderToStaticMarkup(<PageShell>content</PageShell>);
    expect(html).toContain('href="#main"');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('id="main"');
  });

  it("says the site uses reCAPTCHA in the footer, as Google's FAQ requires when the badge is hidden", () => {
    expect(RECAPTCHA_ATTRIBUTION).toBe("This site is protected by reCAPTCHA.");
    expect(renderToStaticMarkup(<SiteFooter />)).toContain(
      "This site is protected by reCAPTCHA.",
    );
  });
});

describe("landing page", () => {
  const html = renderToStaticMarkup(<Home />);

  it("has one h1 and links only to routes that exist", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    for (const href of ["/docs", "/redoc", "/openapi.json", "/api/health"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("does not promise booking pages that are not there yet", () => {
    expect(html).not.toContain('href="/doctors"');
    expect(html).toContain("Online booking pages are coming next");
  });
});
