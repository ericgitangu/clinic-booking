# ADR-0024: Google sign-in for patients and admin, with Better Auth

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0012](0012-identity-and-abuse-controls-deferred.md), [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status

**Amended 2026-10-17: each app has its own Better Auth instance and cookie, and the admin app only lets the allowlisted email sign in at all ([ADR-0027](0027-two-apps-in-a-workspace.md)); the redirect URIs follow the hostnames in [ADR-0028](0028-public-hostnames.md).**

Accepted. Patients and the admin sign in with Google, and the web app's server side (the BFF) is the only place that checks the session. The public REST API stays exactly as the brief specifies: no authentication, working from Swagger.

**Build status (2026-10-18, main 748d7d8): Shipped.** Better Auth with stateless cookie sessions, patient account linking, `/internal/me` and signed internal assertions. Roles are resolved on every request from the `ADMIN_EMAILS` owner list plus API-managed access. Each app has its own instance (ADR-0027).

## Context

- The brief asks for an API with no authentication, and that API is unchanged. But a booking UI with no identity shows every patient everything, which is the IDOR we have been stating as debt (ADR-0012).
- Closing it inside the public API would change the brief's contract. Closing it in the layer the UI talks to does not.
- The earlier plan used Auth.js v5. Its own installation page now says "The Auth.js project is now part of Better Auth", points to a migration guide, and installs v5 only as `next-auth@beta` (<https://authjs.dev/getting-started/installation>, read 2026-10-17).

## Considered options

1. Auth.js v5 (`next-auth@beta`). Still a pre-release, and its maintainers have moved to Better Auth.
2. Better Auth. Actively maintained, has a Next.js integration, a Google provider and a database-free (stateless) session mode.
3. Roll our own OIDC verification against Google's keys. More code to get wrong, nothing gained.
4. Put authentication into the public API. Breaks the brief.

## Decision

Option 2, Better Auth.

- **Integration:** Next.js 16 route handler through `toNextJsHandler(auth)`, session read with `auth.api.getSession({ headers: await headers() })` in server components and server actions, and a `proxy.ts` that only redirects optimistically (the docs are explicit that the cookie check does not validate). Every real check happens server-side (<https://www.better-auth.com/docs/integrations/next>).
- **Base path `/auth`, on both sides.** `/api/[...path]` belongs to the proxy and a check enforces that it is the only route file under `web/src/app/api`, so Better Auth is mounted elsewhere. The server sets `basePath: "/auth"`, and the client is created with the full URL including the path (`baseURL: "<origin>/auth"`, which the docs allow instead of `basePath`) so the two cannot drift; a test asserts both resolve to the same path (<https://www.better-auth.com/docs/reference/options>). The Google redirect URI is `https://sil-clinic-booking.vercel.app/auth/callback/google`.
- **Sessions:** stateless. With no database configured Better Auth runs in stateless mode with the session in a signed, encrypted cookie (`session.cookieCache` with `strategy: "jwe"`, `refreshCache: true`, `account.storeStateStrategy: "cookie"`), so there is no auth database and no extra Neon load (<https://www.better-auth.com/docs/concepts/session-management>). The cost is that a session cannot be revoked early; the lifetime is 7 days, and bumping `cookieCache.version` and redeploying signs everyone out.
- **Google:** one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel environment variables only (<https://www.better-auth.com/docs/authentication/google>). The consent screen is "External" and published, so any Google account can sign in; "Testing" mode would admit only listed users. `socialProviders.google.requireEmailVerification` is on, so no session exists for an address Google has not verified, and the role check below also reads `emailVerified` (<https://www.better-auth.com/docs/reference/options>).
- **Roles:** computed on the server in the session itself, with Better Auth's `customSession` plugin: `role = "admin"` if and only if the verified email is `developer.ericgitangu@gmail.com`, otherwise `"patient"`. The allowlist is server code; the client only sees the result and never decides anything.
- **Patient ownership (the IDOR fix):**
  - A new table `patient_accounts(google_sub primary key, patient_id, email, created_at)`, an expand-only migration. `patients` already has a nullable `email` column; it is left alone.
  - `POST /internal/accounts/link` is an idempotent upsert keyed on `google_sub`: the first call creates a patient from the Google name and email and records the mapping, later calls return the same patient. It never adopts an existing patient that happens to have the same email, because patients can be created through the open public API and adopting one would hand someone else's appointments to whoever signs in with that address.
  - The BFF books, lists, cancels and reschedules only through `/internal/me/...` endpoints. The patient id comes from the account mapping, never from anything the browser sends. An appointment that is not the caller's answers 404, not 403, so ids cannot be probed.
- **`/internal/*` is not reachable from outside.** These paths are left out of the public OpenAPI document, and the proxy refuses any request whose normalised path starts with `internal`: it already rejects segments containing `%` (encoded dots and slashes) and verifies the target it builds, and the rule adds that, after those checks, the first segment compared case-insensitively must not be `internal`. Tests cover `/api/internal/x`, `/api/%69nternal/x`, `/api/./internal/x`, `/api/a/../internal/x` and `/api/Internal/x`. The BFF reaches the API directly with its own identity token ([ADR-0023](0023-zero-cost-edge-front-door.md)).
- **The BFF to API assertion.** Every `/internal/*` call carries `X-Internal-Assertion: v1.<payload>.<mac>`: `payload` is the base64url of canonical JSON (keys sorted, no whitespace) of `{aud: "clinic-api/internal", sub, email, role, iat, exp, m, p, bh}`, where `m` is the HTTP method, `p` the path with query, and `bh` the SHA-256 of the body; `mac` is the base64url HMAC-SHA256 of the payload with `INTERNAL_SIGNING_KEY`. The API recomputes `m`, `p` and `bh` from the request, compares in constant time, allows 5 seconds of clock skew and a TTL of 60 seconds, and requires `role = "admin"` for `/internal/admin/*`. There is no replay store: within the 60 seconds only a byte-identical request can be replayed, and booking has an Idempotency-Key. Rotation: add a new secret version, update the Vercel variable and redeploy both, destroy the old version; calls fail for a few minutes in between, which is accepted.
- **Caching:** every `/internal/me/*` fetch is `cache: "no-store"` and no page that reads a session is cached or shared (ADR-0010).
- **Secrets:** `BETTER_AUTH_SECRET` and `GOOGLE_CLIENT_SECRET` are set with `vercel env add` (sensitive) and never written to a file. `INTERNAL_SIGNING_KEY` is set the same way in Vercel and is the one new Secret Manager secret, because the API needs it too.

## Consequences

- Good: the UI only ever shows a patient their own appointments, and the admin area has a real boundary.
- Good: the public API and Swagger keep working unauthenticated, as the brief says.
- Good: no auth database and no Auth.js beta dependency.
- Bad: the public REST API is still open, so the IDOR still exists there by design; it is closed in the BFF, not in the API. The README says so.
- Bad: stateless sessions cannot be revoked individually.
- Bad: one more Secret Manager version. With the two database URLs that is three in steady state and four during a rotation, about $0.18 and $0.24 a month on the shared account, which stays inside the accepted total of about $0.28 including the registry ([ADR-0014](0014-hosting-region-and-cost.md)).
- Bad: Google's consent screen needs a one-time manual setup in the Cloud console.

## Assessment line

"Patients can cancel" and "must not be available to others": a patient sees and changes only their own appointments, through the UI.

## Review trigger

A need to revoke a single session immediately, or per-clinic staff roles. Either moves sessions to a database and the admin allowlist to a role table.
