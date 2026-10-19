import { NAV_LINKS } from "@/components/layout/nav-links";
import { ADMIN_APP_LIVE, FOOTER_COLUMNS } from "@/lib/footer-links";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The status line calls the API on the server; the page test only needs its place in the markup.
vi.mock("@/components/landing/status-line", () => ({
  StatusLine: () => null,
  StatusPending: () => null,
}));
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

  it("has one h1 with the exact app name, and the one-line description", () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(`>${SITE.name}</h1>`);
    expect(html).toContain(
      "A clinic appointment API with a booking app, built for the Savannah Informatics backend assessment.",
    );
  });

  it("leads with the booking page and links Swagger and the source", () => {
    expect(html).toContain('href="/book"');
    expect(html).toContain('href="/docs"');
    expect(html).toContain(
      'href="https://github.com/ericgitangu/clinic-booking"',
    );
    expect(html).not.toContain("coming next");
  });

  it("has a Swagger deep link and a screen link on every evidence card", () => {
    expect((html.match(/href="\/docs#\//g) ?? []).length).toBe(6);
    expect((html.match(/Try it in Swagger/g) ?? []).length).toBe(6);
  });

  it("names the sections the brief reader looks for", () => {
    for (const t of [
      "What the brief asked for, and where to try it",
      "Verify the claims in 10 minutes",
      "How it\u2019s built",
      "AI reflection (README \u00a711)",
    ]) {
      expect(html, t).toContain(t);
    }
  });

  it("tells the reader how to point the steps at a local stack", () => {
    expect(html).toContain("API=http://localhost:8080");
  });

  it("links the README sections it cites", () => {
    expect(html).toContain("#2-verify-the-claims-in-10-minutes");
    expect(html).toContain("#11-ai-reflection");
    expect(html).toContain("#10-operations-cost--security-posture");
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
