# ADR-0012: Identity and abuse controls: patient auth deferred; admin OAuth and Turnstile as gated stretch

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, admin-only OAuth (S3) and a UI bot check (S4) added as gated stretch; detail in [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status
Accepted. Lean core: no patient auth, no rate limiting, no booking cap, no bot protection at the API. Gated stretch: Google OAuth for the admin area only (S3) and Cloudflare Turnstile on the UI booking route (S4), both per ADR-0022.

## Context
- **The gap.** Without identity, anyone holding an appointment UUID can cancel or reschedule it, and `GET /patients/{id}/appointments` exposes PII. That is IDOR.
- **The brief.** It doesn't mention auth.
- **Why not mandatory auth.** It would answer 401 to a reviewer trying the brief's endpoints as written.
- **What we evaluated and found fragile.** An earlier design used a web-hosted identity provider (Better Auth + Google), demo tokens and JWKS verification. The API would depend on the web app's JWKS at runtime. It needed a second database and a second migration system. A Google consent screen in Testing mode admits only listed users, so reviewers could not sign in.
- **Abuse controls.** Rate limiting needs a correct client-IP derivation behind Cloud Run. A booking cap invents a business rule. reCAPTCHA v3 scores need tuning traffic we don't have.

## Considered options
1. No auth in v1, with the IDOR stated plainly and the layering path written down.
2. Optional bearer auth: ownership enforced when a token is present.
3. Mandatory auth (OAuth + JWT).

## Decision
Option 1.
- **README.** Section 10 of the README states the IDOR, and the phone-exists oracle .
- **Future auth, as one FastAPI dependency `current_principal`:**
  - The contract doesn't change. `patient_id` stays in the body, a mismatch returns 403, and non-owners get 404 on path resources (anti-enumeration).
  - The ownership check runs before the existence lookup.
  - Tokens are OIDC (Google or a clinic IdP), verified with pinned algorithms.
  - The issuer is dispatched before key lookup, and JWKS is cached with single-flight refetch and a cooldown.
  - Role claims are never trusted.
- **Future rate limiting:**
  - Key on the right-most `X-Forwarded-For` entry that Cloud Run appends. Confirm the position by observation. Never use `--proxy-headers` with `--forwarded-allow-ips='*'`.
  - **Amended by the $0 audit ([ADR-0023](0023-zero-cost-edge-front-door.md)):** behind the front door the right-most entry is Vercel's egress address, not the client. Key instead on `X-Client-IP`, which the front door always overwrites with the client address Vercel reports. That header is trustworthy only because Cloud Run admits nothing but the front door (no `allUsers` invoker).
  - Key on `sub` only after the token is verified. Exempt OPTIONS.
  - Start around 60 mutations/min per key.
  - Turn it off in tests with `RATE_LIMIT_ENABLED=false`.
  - Use per-instance memory first, then Upstash when there are more than 3 instances.
- **Bot protection:** Cloudflare Turnstile verified in the Next server route that submits UI bookings, as stretch S4 (ADR-0022). Direct API calls stay unprotected; enforcement inside the API waits for API auth.
- **Admin identity:** Google ID tokens verified in FastAPI against Google's JWKS with an email allowlist, for `/admin` only, as stretch S3 (ADR-0022). This reuses the future-auth rules above (pinned algorithms, issuer dispatch, cached JWKS with single-flight and cooldown, no trusted role claims) and adds no second database. Patient endpoints remain unauthenticated.
- **Stream caps:** the only rate-style limit that is built is the gateway's per-IP and per-instance concurrent stream cap (stretch S1, ADR-0021). General rate limiting stays deferred.
- **Booking cap:** none. A cap would lock reviewers out of shared demo patients and block the smoke test.

## Consequences
- Good: the brief's endpoints work exactly as written for reviewers. No fragile cross-service dependency.
- Bad: IDOR and an open write path, both stated rather than hidden. Turnstile on the UI route (if S4 ships) does not close for direct API callers.

## Assessment line
"Patients can cancel"; "Patients book online". The gap is documented, not half-built.

## Review trigger
Any real patient data (auth is then mandatory), or observed abuse in the logs (rate limiting).
