# ADR-0028: Public hostnames on ericgitangu.com

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0023](0023-zero-cost-edge-front-door.md), [ADR-0024](0024-google-sign-in-with-better-auth.md), [ADR-0026](0026-branding-and-seo.md)

## Status

Accepted. Patients use `clinic.ericgitangu.com`; the admin uses `clinic-admin.ericgitangu.com`. The `sil-clinic-booking.vercel.app` alias stays during the cut-over and is then demoted to a redirect.

**Build status (audit 2026-10-17): Mostly built.** Both apps carry their new hostnames in code, CI and the README. Pending: demoting the `sil-clinic-booking.vercel.app` alias to a redirect. DNS, OAuth client and reCAPTCHA settings are outside the repository and unconfirmed here.

## Context

- The site is on a generated `*.vercel.app` name today, which is wired into sign-in, reCAPTCHA, CI and the docs. With two apps ([ADR-0027](0027-two-apps-in-a-workspace.md)) each needs its own address, and the engineer wants them on the engineer's own domain.
- The domain's DNS is not on Vercel. Its name servers are Google's (`ns-cloud-a1..a4.googledomains.com`, seen with `dig` on 2026-10-17, so Google Domains or its successor Squarespace), so Vercel cannot create the records itself.
- The Google Cloud project id `sil-clinic-booking` is internal and immutable, so it stays and is never shown to users.

## Considered options

1. Keep the `*.vercel.app` names. Free, but unbranded and a poor address for patients.
2. One custom domain with paths (`/admin`). Contradicts the two-app split.
3. Two subdomains of `ericgitangu.com`, one per app. Chosen.

## Decision

Option 3.

- **Domains:** added to each Vercel project as custom domains, which Hobby allows (50 per project, <https://vercel.com/docs/limits>, read 2026-10-17), so they cost nothing beyond the domain the engineer already owns.
- **DNS:** the engineer adds one CNAME per name at the DNS host, with the target Vercel shows for that domain (`vercel domains inspect` prints the exact record). No other records change. Verification is `vercel domains inspect` plus a `curl` of each host.
- **Cut-over, additive first:** add the domains and wait for them to verify; add the new hosts to every allow-list below while the old ones stay; switch the variables that name the site; run `verify_claims.py` against both hosts; keep the old alias a while; then demote it (a redirect to the new host, and remove it from the allow-lists).

### Every place the old host is wired

| Where | What changes |
|---|---|
| Google OAuth client (in `sil-clinic-booking`) | Authorised origins and redirect URIs for both new hosts (`/auth/callback/google` on each), plus `http://localhost:3000` (booking) and `http://localhost:3001` (admin). The old host stays until the demotion. |
| `BETTER_AUTH_URL` in each app's Vercel env | The app's own origin. |
| reCAPTCHA key allowed domains | Add `clinic.ericgitangu.com` (booking is the only app with forms that use it); keep the old host and `localhost` during the cut-over; update with `gcloud recaptcha keys update`. |
| CircleCI `gcp-deploy` context | `PUBLIC_BASE_URL` (`https://clinic.ericgitangu.com/api`) and `WEB_ORIGIN` (`https://clinic.ericgitangu.com`). |
| `scripts/ci/public-urls.env` | `WEB` for booking and a new `ADMIN`; `RUN_APP_URL` is unchanged. |
| API CORS | One origin, `WEB_ORIGIN`: only the booking site calls the API from a browser origin. Both apps call it from the server, so the admin host is not added. |
| Branding and SEO (`SITE.url` in each app) | `metadataBase`, canonical, Open Graph, sitemap, robots, manifest start URL. |
| README and runbooks | The live-URL table, the verification commands, the bootstrap steps for the domain and key, the rollback runbook's `WEB`. |
| Production alias handling (`scripts/ci/vercel_prod.sh`) | Resolve the deployment behind the app's primary host; the `vercel.app` alias is kept as an extra domain, not the primary. |
| Tests | The metadata tests read `SITE.url`, not a literal; e2e runs on `localhost`. No change beyond the constant. |
| Unchanged | Cloud Run URL and invoker bindings (IAM, not hostnames), the Vercel identity subjects (project names, not hosts), the Resend sender domain (already verified), the GCP project id. |

- **Cookies:** host-only, so the two subdomains never share a session ([ADR-0027](0027-two-apps-in-a-workspace.md)).
- **Email:** links in emails use the booking host.

## Consequences

- Good: branded, separate addresses, still $0.
- Good: the cut-over is additive, so nothing breaks while records propagate.
- Bad: the DNS records are added by hand at a provider the repo cannot reach, and OAuth and reCAPTCHA changes take a few minutes to propagate.
- Bad: many places to update, which is why this ADR lists them.

## Assessment line

Section 1 "key decisions": the public address of each audience is a decision, recorded with everything it touches.

## Review trigger

Moving the DNS to Vercel (which lets the CLI manage records), or a third hostname.
