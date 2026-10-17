import { NAV_LINKS } from "@/components/layout/nav-links";
import { ADMIN_APP_LIVE, FOOTER_COLUMNS } from "@/lib/footer-links";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "@/app/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { CONTACT_EMAIL, FOOTER_NOTICE, SITE } from "@/lib/site";
import { PageShell } from "@clinic/ui/components/layout/page-shell";
import {
  RECAPTCHA_ATTRIBUTION,
  SiteFooter,
} from "@clinic/ui/components/layout/site-footer";

describe("page shell", () => {
  it("offers a skip link to a single main landmark", () => {
    const html = renderToStaticMarkup(
      <PageShell
        name={SITE.name}
        navLinks={NAV_LINKS}
        footerColumns={FOOTER_COLUMNS}
        footerNotice={FOOTER_NOTICE}
      >
        content
      </PageShell>,
    );
    expect(html).toContain('href="#main"');
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toContain('id="main"');
  });

  it("says the site uses reCAPTCHA, with Google's policy links, as the footer sentence", () => {
    const html = renderToStaticMarkup(
      <SiteFooter columns={FOOTER_COLUMNS} notice={FOOTER_NOTICE} />,
    );
    const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(RECAPTCHA_ATTRIBUTION).toBe(
      "This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.",
    );
    expect(text).toContain(RECAPTCHA_ATTRIBUTION);
    expect(html).toContain('href="https://policies.google.com/privacy"');
    expect(html).toContain('href="https://policies.google.com/terms"');
  });

  it("links the privacy and terms pages from the footer", () => {
    const html = renderToStaticMarkup(
      <SiteFooter columns={FOOTER_COLUMNS} notice={FOOTER_NOTICE} />,
    );
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/data"');
  });

  it("links the admin app while it is live", () => {
    const html = renderToStaticMarkup(
      <SiteFooter columns={FOOTER_COLUMNS} notice={FOOTER_NOTICE} />,
    );
    expect(ADMIN_APP_LIVE).toBe(true);
    expect(html).toContain('href="https://clinic-admin.ericgitangu.com"');
  });

  it("opens other sites safely and names every column", () => {
    const html = renderToStaticMarkup(
      <SiteFooter columns={FOOTER_COLUMNS} notice={FOOTER_NOTICE} />,
    );
    for (const title of [
      "Clinic",
      "Assessment",
      "Legal",
      "Built by Eric Gitangu",
    ]) {
      expect(html).toContain(`aria-label="${title}"`);
    }
    const external = html.match(/<a [^>]*target="_blank"[^>]*>/g) ?? [];
    expect(external.length).toBeGreaterThan(10);
    for (const a of external) expect(a).toContain('rel="noopener noreferrer"');
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

describe("legal pages", () => {
  it.each([
    [
      "privacy",
      PrivacyPage,
      "Privacy",
      ["Google", "reCAPTCHA", "Resend", "phone"],
    ],
    ["terms", TermsPage, "Terms", ["medical advice", "demonstration"]],
  ] as const)(
    "%s has one h1, says what it must, and gives a contact",
    (_n, Page, title, words) => {
      const html = renderToStaticMarkup(<Page />);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain(`>${title}</h1>`);
      for (const w of words) expect(html).toContain(w);
      expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
    },
  );
});
