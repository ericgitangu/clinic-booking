# ADR-0026: Branding and SEO

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer

## Status

**Amended 2026-10-17: each app has its own `SITE.url`, icons and metadata, built on the shared `packages/ui` ([ADR-0027](0027-two-apps-in-a-workspace.md)); the public URLs are in [ADR-0028](0028-public-hostnames.md).**

Accepted. The site carries the Idyllic brand and is set up so a link to it previews properly and a crawler can read it.

## Context

A booking site that looks like a template and shares as a blank card does not read as finished. The Idyllic logos already exist in a sibling project (`../unicorns/web/public/`: `idyllic-logo.png`, `idyllic-logo-dark.png`, `idyllic-mark.png`).

## Considered options

1. Leave the defaults.
2. Copy the three logo files, generate icons and the share image from code, and use the Metadata API with `sitemap.ts` and `robots.ts`.
3. A designed brand kit from scratch. More time than the value.

## Decision

Option 2.

- **Assets:** copy only what is used into `web/public`: the light logo, the dark logo and the mark.
- **Icons:** Next.js file conventions: a static `app/favicon.ico`, plus `app/icon.tsx` and `app/apple-icon.tsx` as `ImageResponse` routes, with `generateImageMetadata` producing the 192 and 512 pixel icons the manifest needs (<https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons>, read 2026-10-17). They are generated from the mark and the PWA manifest icons use the same source.
- **Share image:** `app/opengraph-image.tsx` with `ImageResponse` from `next/og`, rendered at build time. `images.unoptimized` stays on, so image optimization (5,000 transformations on Hobby) is never used.
- **Footer:** one `SiteFooter` component on every page, carrying the reCAPTCHA attribution required while the badge is hidden ([ADR-0022](0022-admin-auth-and-bot-protection.md)).
- **Metadata:** the Metadata API in the root layout (title template, description, `metadataBase` set to the production URL, Open Graph and Twitter cards), per-page titles, and the theme colour in the `viewport` export (light and dark values).
- **Crawling:** `app/sitemap.ts` lists the public pages and `app/robots.ts` allows them and disallows `/admin`, `/auth` and `/cron`.
- **Check:** Lighthouse on the deployed preview, signed out, for `/`, `/doctors` and one doctor page: at least 90 for accessibility and SEO on each. The signed-in pages (`/appointments`, `/admin`) are not run through Lighthouse; they get an automated accessibility check in the Playwright tests instead, because they need a session.

## Consequences

- Good: links preview with the brand, the site has real icons, and search engines get a sitemap.
- Good: no new service and no runtime cost; everything is built or generated at build time.
- Bad: the logo files are copies, so a change in the other project is not picked up.

## Assessment line

Section 4 "Honesty matters" and the quality of the delivered product: it should look intentional.

## Review trigger

A custom domain, a rebrand, or a Lighthouse score that falls below the threshold.
