# ADR-0022: Admin-only OAuth and UI bot protection (Google sign-in and bot check)

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted, with two changes of mind that supersede the original design below:

- **Google sign-in is reinstated** for patients and the admin, specified in [ADR-0024](0024-google-sign-in-with-better-auth.md) with Better Auth instead of Auth.js.
- **Bot protection is reinstated, with reCAPTCHA instead of Turnstile** (2026-10-17, decided by the engineer). It is specified in the section "Bot protection with reCAPTCHA" at the end of this ADR. The Turnstile design in the body stays as the record of what was considered.

Patient authentication of the public REST API remains out of scope ([ADR-0012](0012-identity-and-abuse-controls-deferred.md)).

**Build status (2026-10-18, main a2d1117): Superseded in part.** Google sign-in is built under ADR-0024 and the reCAPTCHA check runs in the booking server actions for book, reschedule and cancel. The Auth.js, Google JWKS and Turnstile designs were not built and stay as the record. The stream ticket is superseded by Ably tokens (ADR-0031).

## Context

- **What the realtime gateway exposes.** `/admin`, `GET /admin/metrics` and the gateway's `/stream` carry only non-PII aggregates, so they are public until sign-in ships. Once an admin area exists it should have an admin boundary.
- **What the red-team rejected earlier.** Better Auth made the API depend at runtime on the web app's JWKS, needed a second database, and a Google consent screen in Testing mode admits only listed users (ADR-0012).
- **EventSource cannot set headers.** A browser stream cannot carry `Authorization: Bearer`.
- **Reviewers must keep working.** Swagger and curl against the required endpoints must keep working without credentials or challenges.
- **Bot protection options.** reCAPTCHA v3 returns a score that needs a threshold tuned on traffic we don't have, and it brings Google tracking and a consent burden for patients. Cloudflare Turnstile is free, does not use the same tracking model, and needs no score threshold. Both providers issue single-use tokens: Google's docs say a reCAPTCHA token is valid for two minutes and can be verified only once (`siteverify` returns `timeout-or-duplicate`), and Turnstile's `siteverify` rejects a reused token the same way. Replay protection is therefore a property of our design, not a point of difference between the two.

## Considered options

1. **Admin auth:** Auth.js v5 (Google provider) in Next for the session; FastAPI verifies the Google ID token against Google's JWKS with an email allowlist and is the single verifier. How the gateway authenticates is options 4 and 5.
2. **Admin auth:** Better Auth with its own JWKS (rejected earlier, kept here for the record).
3. **Admin auth:** Cloud Run IAM (Google-signed identity tokens checked by the platform).
4. **Stream credential:** a same-origin Next route that proxies the stream and adds the header.
5. **Stream credential:** a short-lived signed stream ticket issued by FastAPI to an authenticated admin, passed as a query parameter.
6. **Bot protection:** reCAPTCHA v3.
7. **Bot protection:** Cloudflare Turnstile, verified in the Next server route that submits UI bookings.
8. **Bot protection:** Turnstile enforced inside FastAPI on `POST /appointments`.

## Decision

> **Superseded (2026-10-18) by [ADR-0024](0024-google-sign-in-with-better-auth.md) and [ADR-0030](0030-staff-roles-and-access.md) for sign-in; not built as written.** The design below (Auth.js v5, a Google ID token forwarded to FastAPI, `require_admin` verifying Google's JWKS against `ADMIN_EMAILS`, the `ADMIN_AUTH_ENABLED` switch and the 401/403/503 admin problem codes) was never built. What is built: Better Auth in each Next.js app, a signed internal assertion that FastAPI verifies (`backend/app/core/assertion.py`), and roles from the `staff_access` table. The stream ticket below still belongs to the realtime gateway (stretch S1, not built). The text stays as the record of what was considered.

**Google sign-in: options 1 and 5.**

- **Session:** Auth.js v5 Google provider, used for `/admin` only. v5 is still published only as a beta (`5.0.0-beta.32`, `npm view next-auth dist-tags` on 2026-10-16), and the library is reported to be in security-patch-only maintenance; we pin the exact beta and accept it as debt because the API's verification does not depend on the web library. The `jwt` callback keeps the Google `id_token` in the encrypted session cookie; client JS never sees it. Next server routes under `/admin/api/*` forward it as `Authorization: Bearer` to FastAPI through the proxy's in-process helper `call-api.ts`. Auth.js runs with `basePath: "/auth"`, because `/api/*` belongs to the proxy.
- **Verification lives in FastAPI** (`require_admin`): PyJWT with `PyJWKClient` on Google's JWKS, cached with single-flight refetch and a cooldown; RS256 only; `iss` in {`https://accounts.google.com`, `accounts.google.com`}; `aud` equal to our OAuth client id; `exp`; `email_verified`; lowercased email in `ADMIN_EMAILS`. Role, `hd` and other claims are ignored. `aud` alone is not a trust boundary: anyone can mint a Google service-account ID token with any audience, so the `aud` check only rejects tokens meant for other clients, and the real gate is `email_verified` plus the allowlist. This removes the Vercel-JWKS runtime coupling: the API depends only on Google's published keys, and there is no second database.
- **Stream ticket, not a proxy:** `POST /admin/stream-ticket` returns an HMAC-SHA256 ticket (`v`, `aud: clinic-realtime`, `exp` 60 s; no email, no `jti`). The ticket is reusable until it expires; we state that rather than carry a `jti` that nothing checks. The browser opens `/stream?cursor=...&ticket=...`; the Go gateway checks it with `hmac.Equal`, `aud` and `exp` at connect time only, and the client fetches a fresh ticket before every reconnect. A Next proxy (option 4) would hold a Vercel function open for each stream (billed, duration-capped on Hobby) and add a hop to the long-lived path. The ticket keeps the stream direct to Cloud Run and keeps Go on the standard library with no JWT/JWKS code, so there is one Google-token verifier in the codebase.
  - **Amended by the $0 audit (2026-10-16, [ADR-0023](0023-zero-cost-edge-front-door.md)).** The stream is no longer direct to Cloud Run: every request, the stream included, passes through the generic proxy route handler `/api/[...path]` in the `web` project, because a direct response from Cloud Run to a browser in Kenya is billed egress from byte 0. The ticket stays, for the reason that still holds: the front door is a dumb, path-preserving proxy with no admin logic, and EventSource still cannot set headers, so admin gating for `/stream` remains the 60 s ticket checked in Go. The cost the original text avoided (a Vercel function held open per stream) is now accepted and counted against Hobby's 360 GB-h provisioned-memory allowance; the 290 s stream limit fits Hobby's 300 s maximum duration.
- **Errors:** 401 `ADMIN_AUTH_REQUIRED` (+ `WWW-Authenticate: Bearer`), 403 `ADMIN_FORBIDDEN`, 503 `ADMIN_AUTH_UNAVAILABLE`.
- **Amended by the hosting lock review:** the ticket (`POST /admin/stream-ticket`, the Go check, the `clinic-stream-ticket-key` secret) moves from sign-in to the realtime gateway and `STREAM_AUTH_REQUIRED=true` in Cloud Run from the realtime gateway on, because the ticket is where a monthly connected-seconds budget is enforced (each ticket debits 700 s; exhausted → 503 `STREAM_BUDGET_EXHAUSTED`); the gateway's 401 is `STREAM_TICKET_REQUIRED`. Before sign-in, any caller can get a ticket, but only within the budget. sign-in adds Google auth in front of the ticket route; the boundary below is unchanged.
- **Switch:** `ADMIN_AUTH_ENABLED` / `STREAM_AUTH_REQUIRED` default false and flip to true in the ship jobs when sign-in lands (`STREAM_AUTH_REQUIRED` flips with the realtime gateway instead, per the amendment above). While false (local, CI, Schemathesis), `require_admin` is a no-op, `POST /admin/stream-ticket` returns 200 with a ticket to any caller, and the gateway ignores tickets; both flag values are tested. OpenAPI declares the 401/403/503 responses unconditionally, so the exported contract does not depend on the environment, and Schemathesis only ever sees declared statuses.
- **Smoke:** the post-deploy stream smoke keeps its positive path after sign-in by minting a `clinic-smoke` service-account ID token (deployer has `serviceAccountTokenCreator` on that SA only). If that cannot work, sign-in is dropped rather than shrinking the smoke to two 401 checks (ADR-0016).
- **Option 3 rejected:** Cloud Run IAM would also block the browser's EventSource and the reviewer-facing public URLs, and it needs per-user IAM bindings.
  - **Amended (ADR-0023):** Cloud Run IAM is now on, but as a cost control with a single service identity (`clinic-web`, the web project's proxy), not as the admin boundary. Browsers and reviewers never hold an IAM token; the front door adds it server-side. The admin boundary is unchanged: Google ID token checks in FastAPI and the ticket in Go.

> **Superseded (2026-10-18) by the reCAPTCHA section at the end of this ADR and [ADR-0029](0029-booking-flow.md); Turnstile was not built.** The route `POST /ui/appointments` and the in-process helper `call-api.ts` below do not exist: the booking server actions in `apps/booking` verify a reCAPTCHA token per action and call the API through `callApi` in `@clinic/api`. The text stays as the record of what was considered.

**Bot check: option 7.**

- The booking dialog renders the Turnstile widget (`action: "book"`) and posts to the same-origin route `POST /ui/appointments` (moved off `/api/*`, which is the proxy's) (Vercel region `iad1`, near the API in us-east4; amended by the $0 audit, because Hobby allows a single function region and the API moved to North America). The route forwards through the proxy's in-process helper `call-api.ts` (it used to read `API_BASE_URL` = the front-door URL), never to `*.run.app` without an ID token. The route verifies the token with `siteverify` (3 s timeout, fail closed) and checks the returned `hostname` and `action`, then forwards the original body and `Idempotency-Key` to the API and returns the API's response unchanged.
- **Direct API calls are not bot-protected.** Swagger, curl and scripts bypass the check by design, so reviewers keep working. Option 8 is the real fix and needs API auth first; until then a bot can call the API directly.
- **Option 6 rejected** for the reasons in Context: v3 is score-only and needs a threshold tuned on traffic we do not have, and it carries Google's tracking and a consent burden for patients. Single-use tokens are not a difference: both providers have them.

**Amendment (2026-10-18), pending build.** The stream tickets in this ADR (the HMAC `POST /admin/stream-ticket` and the Go gateway's check, with the monthly connected-seconds budget) are replaced by short-lived subscribe-only Ably tokens ([ADR-0031](0031-realtime-push-via-ably-sse.md)): the admin token is minted behind the admin role check, the patient token is same-origin and rate limited. There is no gateway left to check a ticket.

## Consequences

- Good: the admin surface gets a real boundary without a user table, a second DB or a cross-service JWKS dependency.
- Good: patients and reviewers see no change to the required endpoints.
- Bad: the ticket travels in a URL and therefore appears in Cloud Run request logs. Mitigated by a 60 s TTL, no email in it, and a stream that carries no PII.
- Bad: admin sessions end with the Google ID token's lifetime, about an hour.
- Bad: with the consent screen in Testing mode, only listed test users can sign in, so reviewers see `/admin` through a recording unless the engineer adds them.
- Bad: the bot check covers only the UI booking route.

## Assessment line

"Meaningful errors + correct HTTP status codes" (401/403/503 problem types); "Patients book online" (abuse on the UI write path). Both are stretch strengthenings, not brief requirements.

## Review trigger

Any real patient data or any authenticated patient flow: build patient auth per ADR-0012, then move bot enforcement into the API (option 8). More than a handful of admins, or a need for roles: a clinic IdP with a proper session and refresh tokens.

## Bot protection with reCAPTCHA

Every Google resource for this app lives in the one dedicated project `sil-clinic-booking`, and every `gcloud` call passes `--project sil-clinic-booking` explicitly. Nothing is created in, reused from or referenced in another project.

- **Which reCAPTCHA:** reCAPTCHA through Google Cloud (the Enterprise API with a score-based key, the "v3-style" integration), not the classic secret-key flow. There is therefore no secret to hold: the BFF authenticates to the API with its existing Vercel identity.
- **Key:** created in `sil-clinic-booking` with `gcloud recaptcha keys create --web --integration-type=score --domains=sil-clinic-booking.vercel.app,localhost`. The site key is public and is set as `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` in Vercel (production) and in the gitignored `apps/booking/.env.local`. The API `recaptchaenterprise.googleapis.com` is enabled by Terraform.
- **Where it runs:** only in the BFF, on the server actions for booking, rescheduling and cancelling, and on sign-up if there is one. Each form has its own action name (`book`, `reschedule`, `cancel`, `signup`), and the BFF checks that the action in the token equals the one the form should have used.
- **Verification:** the BFF calls `projects.assessments.create` with the token, the site key and the expected action, and accepts only if `tokenProperties.valid` is true, `tokenProperties.action` equals the expected action, and `riskAnalysis.score` is at least `RECAPTCHA_MIN_SCORE` (default 0.5, set in the environment). Tokens expire after two minutes and are single use (<https://docs.cloud.google.com/recaptcha/docs/create-assessment-website>, read 2026-10-17). A missing, invalid, expired, wrong-action or low-score token is refused with a friendly "please try again" and the action is not performed.
- **Identity, no secret:** a new service account `clinic-recaptcha` holds only `roles/recaptchaenterprise.agent`. The Vercel OIDC principal (the same federated identity as [ADR-0023](0023-zero-cost-edge-front-door.md)) may mint short-lived tokens for that one account (`roles/iam.serviceAccountTokenCreator` on it) and nothing else. The BFF exchanges its Vercel token for a Google token, impersonates `clinic-recaptcha`, and calls the API. Terraform creates all of it and the plan is grepped for anything outside that list before it is applied.
- **The badge is hidden, and the page says so.** The floating badge is hidden with `.grecaptcha-badge { visibility: hidden; }` and every page footer carries the attribution Google's FAQ now requires: "This site is protected by reCAPTCHA." (<https://docs.cloud.google.com/recaptcha/docs/faq>, read 2026-10-17). The engineer's brief quoted the older longer sentence with links to Google's Privacy Policy and Terms of Service. The FAQ says that since 2 April 2026 those references are removed from the badge itself and recommends removing them from customer sites too, so the footer uses the current sentence; adding the two links back is a one-line change if the engineer prefers the older wording.
  - **Amendment (2026-10-18): the footer as built uses the longer wording.** `RECAPTCHA_ATTRIBUTION` in `packages/ui/src/components/layout/site-footer.tsx` reads "This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply." The engineer chose the older, longer sentence; the shorter sentence quoted above is not what the footer shows.
- **Cost:** the Google Cloud pricing and tier pages give a free allowance of 10,000 assessments per calendar month per organization, aggregated over all accounts and sites, then a flat $8 for 10,001 to 100,000 assessments (<https://docs.cloud.google.com/recaptcha/docs/compare-tiers>, <https://docs.cloud.google.com/recaptcha/docs/billing-information>, read 2026-10-17). We make one assessment per booking, reschedule or cancel attempt, so a month of demo traffic is a few hundred at most, far inside the allowance: $0. The risk is the cliff: past 10,000 the month costs $8. It is bounded by the per-IP rate limit in the proxy, the spend alert on this project, and the fact that the check runs only on form submissions, never on page views. The allowance is per organization, so if other projects under the same organization also use reCAPTCHA their assessments count against the same 10,000; this project has no way to see that, which is stated here rather than assumed away.
- **Limit, stated plainly:** the public REST API, used through Swagger or curl, is not protected by this. That is deliberate: the brief specifies an open API. The check protects the web app's form path only.
- **Preview deployments:** the Vercel identity provider only accepts tokens from the production environment (`environment:production`), so a preview deployment has no Google identity. A preview therefore cannot verify a token or reach Cloud Run. Previews either run with verification switched off (`RECAPTCHA_ENFORCE=false`, never in production) or are built as production-target deployments of the branch before merging. This is an open point for the slice that builds it.

## Consequences of the reCAPTCHA decision

- Good: no secret, no API key, no new vendor; a reCAPTCHA decision the BFF cannot forge because the score comes from Google.
- Good: costs $0 at this volume.
- Bad: tokens need a working browser, so scripted clients of the web app fail by design (the REST API is still open to them).
- Bad: a new service account, a new role and a new API to keep in Terraform.
- Bad: an $8 cliff if the shared monthly allowance is exceeded.
