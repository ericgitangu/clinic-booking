# ADR-0022: Admin-only OAuth and UI bot protection (stretch S3, S4)

- Date: 2026-10-16
- Deciders: engineering
- Plan reference: [PLAN.md §3.10, WP-S3, WP-S4](../architecture/PLAN.md#310-stretch-s3s4-admin-auth-flow-and-ui-bot-check)

## Status
Accepted (gated stretch: S3 cut 2nd, S4 cut 1st). Patient authentication remains deferred under ADR-0012.

**Amended 2026-10-16: S3 and S4 are cut by the engineer 2026-10-16, deferred with review trigger.** Review trigger: an admin area that serves more than the unauthenticated aggregates, or observed abuse of the public booking route. The design below is kept unchanged for that day.

## Context
- **What S1 exposes.** `/admin`, `GET /admin/metrics` and the gateway's `/stream` carry only non-PII aggregates, so they are public until S3 ships. Once an admin area exists it should have an admin boundary.
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
**S3: options 1 and 5.**
- **Session:** Auth.js v5 Google provider, used for `/admin` only. v5 is still published only as a beta (`5.0.0-beta.32`, `npm view next-auth dist-tags` on 2026-10-16), and the library is reported to be in security-patch-only maintenance; we pin the exact beta and accept it as debt because the API's verification does not depend on the web library (PLAN.md K34, TD27). The `jwt` callback keeps the Google `id_token` in the encrypted session cookie; client JS never sees it. Next server routes under `/admin/api/*` forward it as `Authorization: Bearer` to FastAPI through the proxy's in-process helper `call-api.ts`. Auth.js runs with `basePath: "/auth"`, because `/api/*` belongs to the proxy (PLAN.md §12.3).
- **Verification lives in FastAPI** (`require_admin`): PyJWT with `PyJWKClient` on Google's JWKS, cached with single-flight refetch and a cooldown; RS256 only; `iss` in {`https://accounts.google.com`, `accounts.google.com`}; `aud` equal to our OAuth client id; `exp`; `email_verified`; lowercased email in `ADMIN_EMAILS`. Role, `hd` and other claims are ignored. `aud` alone is not a trust boundary: anyone can mint a Google service-account ID token with any audience, so the `aud` check only rejects tokens meant for other clients, and the real gate is `email_verified` plus the allowlist. This removes the Vercel-JWKS runtime coupling: the API depends only on Google's published keys, and there is no second database.
- **Stream ticket, not a proxy:** `POST /admin/stream-ticket` returns an HMAC-SHA256 ticket (`v`, `aud: clinic-realtime`, `exp` 60 s; no email, no `jti`). The ticket is reusable until it expires; we state that rather than carry a `jti` that nothing checks. The browser opens `/stream?cursor=...&ticket=...`; the Go gateway checks it with `hmac.Equal`, `aud` and `exp` at connect time only, and the client fetches a fresh ticket before every reconnect. A Next proxy (option 4) would hold a Vercel function open for each stream (billed, duration-capped on Hobby) and add a hop to the long-lived path. The ticket keeps the stream direct to Cloud Run and keeps Go on the standard library with no JWT/JWKS code, so there is one Google-token verifier in the codebase.
  - **Amended by the $0 audit (2026-10-16, [ADR-0023](0023-zero-cost-edge-front-door.md)).** The stream is no longer direct to Cloud Run: every request, the stream included, passes through the generic proxy route handler `/api/[...path]` in the `web` project (PLAN.md §12.3), because a direct response from Cloud Run to a browser in Kenya is billed egress from byte 0. The ticket stays, for the reason that still holds: the front door is a dumb, path-preserving proxy with no admin logic, and EventSource still cannot set headers, so admin gating for `/stream` remains the 60 s ticket checked in Go. The cost the original text avoided (a Vercel function held open per stream) is now accepted and counted in PLAN.md §13 against Hobby's 360 GB-h provisioned-memory allowance; the 290 s stream limit fits Hobby's 300 s maximum duration.
- **Errors:** 401 `ADMIN_AUTH_REQUIRED` (+ `WWW-Authenticate: Bearer`), 403 `ADMIN_FORBIDDEN`, 503 `ADMIN_AUTH_UNAVAILABLE` (PLAN.md §6).
- **Amended by the hosting lock review ([PLAN.md §12.4](../architecture/PLAN.md#124-hosting-lock-review)):** the ticket (`POST /admin/stream-ticket`, the Go check, the `clinic-stream-ticket-key` secret) moves from S3 to S1 and `STREAM_AUTH_REQUIRED=true` in Cloud Run from S1 on, because the ticket is where a monthly connected-seconds budget is enforced (each ticket debits 700 s; exhausted → 503 `STREAM_BUDGET_EXHAUSTED`); the gateway's 401 is `STREAM_TICKET_REQUIRED`. Before S3, any caller can get a ticket, but only within the budget. S3 adds Google auth in front of the ticket route; the boundary below is unchanged.
- **Switch:** `ADMIN_AUTH_ENABLED` / `STREAM_AUTH_REQUIRED` default false and flip to true in the ship jobs when S3 lands (`STREAM_AUTH_REQUIRED` flips with S1 instead, per the amendment above). While false (local, CI, Schemathesis), `require_admin` is a no-op, `POST /admin/stream-ticket` returns 200 with a ticket to any caller, and the gateway ignores tickets; both flag values are tested. OpenAPI declares the 401/403/503 responses unconditionally, so the exported contract does not depend on the environment, and Schemathesis only ever sees declared statuses.
- **Smoke:** the post-deploy stream smoke keeps its positive path after S3 by minting a `clinic-smoke` service-account ID token (deployer has `serviceAccountTokenCreator` on that SA only). If that cannot work, S3 is dropped rather than shrinking the smoke to two 401 checks (ADR-0016).
- **Option 3 rejected:** Cloud Run IAM would also block the browser's EventSource and the reviewer-facing public URLs, and it needs per-user IAM bindings.
  - **Amended (ADR-0023):** Cloud Run IAM is now on, but as a cost control with a single service identity (`clinic-web`, the web project's proxy), not as the admin boundary. Browsers and reviewers never hold an IAM token; the front door adds it server-side. The admin boundary is unchanged: Google ID token checks in FastAPI and the ticket in Go.

**S4: option 7.**
- The booking dialog renders the Turnstile widget (`action: "book"`) and posts to the same-origin route `POST /ui/appointments` (moved off `/api/*`, which is the proxy's, PLAN.md §12.3) (Vercel region ~~`fra1`~~ `iad1`, near the API in us-east4; amended by the $0 audit, because Hobby allows a single function region and the API moved to North America). The route forwards through the proxy's in-process helper `call-api.ts` (before §12.3 it read `API_BASE_URL` = the front-door URL), never to `*.run.app` without an ID token. The route verifies the token with `siteverify` (3 s timeout, fail closed) and checks the returned `hostname` and `action`, then forwards the original body and `Idempotency-Key` to the API and returns the API's response unchanged.
- **Direct API calls are not bot-protected.** Swagger, curl and scripts bypass the check by design, so reviewers keep working. Option 8 is the real fix and needs API auth first; until then a bot can call the API directly (TD22).
- **Option 6 rejected** for the reasons in Context: v3 is score-only and needs a threshold tuned on traffic we do not have, and it carries Google's tracking and a consent burden for patients. Single-use tokens are not a difference: both providers have them.

## Consequences
- Good: the admin surface gets a real boundary without a user table, a second DB or a cross-service JWKS dependency.
- Good: patients and reviewers see no change to the required endpoints.
- Bad: the ticket travels in a URL and therefore appears in Cloud Run request logs (TD21). Mitigated by a 60 s TTL, no email in it, and a stream that carries no PII.
- Bad: admin sessions end with the Google ID token's lifetime, about an hour (TD20).
- Bad: with the consent screen in Testing mode, only listed test users can sign in, so reviewers see `/admin` through a recording unless the engineer adds them (K26).
- Bad: the bot check covers only the UI booking route (TD22).

## Assessment line
"Meaningful errors + correct HTTP status codes" (401/403/503 problem types); "Patients book online" (abuse on the UI write path). Both are stretch strengthenings, not brief requirements.

## Review trigger
Any real patient data or any authenticated patient flow: build patient auth per ADR-0012, then move bot enforcement into the API (option 8). More than a handful of admins, or a need for roles: a clinic IdP with a proper session and refresh tokens.
