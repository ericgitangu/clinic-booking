# ADR-0026: Branding and SEO

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer

## Status

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
- **Icons:** Next.js file conventions. `app/favicon.ico`, `app/icon` and `app/apple-icon` are static files or `ImageResponse` routes (<https://nextjs.org/docs/app/api-reference/file-conventions/metadata/app-icons>, read 2026-10-17). They are generated from the mark and the PWA manifest icons use the same source.
- **Share image:** `app/opengraph-image.tsx` with `ImageResponse` from `next/og`, rendered at build time. `images.unoptimized` stays on, so image optimization (5,000 transformations on Hobby) is never used.
- **Metadata:** the Metadata API in the root layout (title template, description, `metadataBase` set to the production URL, Open Graph and Twitter cards), per-page titles, and a theme colour for light and dark.
- **Crawling:** `app/sitemap.ts` lists the public pages and `app/robots.ts` allows them and disallows `/admin`, `/auth` and `/cron`.
- **Check:** Lighthouse on the deployed preview must score at least 90 for accessibility and SEO on the landing page and the booking page.

## Consequences

- Good: links preview with the brand, the site has real icons, and search engines get a sitemap.
- Good: no new service and no runtime cost; everything is built or generated at build time.
- Bad: the logo files are copies, so a change in the other project is not picked up.

## Assessment line

Section 4 "Honesty matters" and the quality of the delivered product: it should look intentional.

## Review trigger

A custom domain, a rebrand, or a Lighthouse score that falls below the threshold.
