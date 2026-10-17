# ADR-0024: Google sign-in for patients and admin, with Better Auth

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0012](0012-identity-and-abuse-controls-deferred.md), [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status

Accepted. Patients and the admin sign in with Google, and the web app's server side (the BFF) is the only place that checks the session. The public REST API stays exactly as the brief specifies: no authentication, working from Swagger.

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

- **Integration:** Next.js 16 route handler through `toNextJsHandler(auth)`, session read with `auth.api.getSession({ headers: await headers() })` in server components and server actions, and a `proxy.ts` that only redirects optimistically (the cookie check does not validate, per the docs). Every real check happens server-side (<https://www.better-auth.com/docs/integrations/next>).
- **Base path:** `/auth`, not `/api/auth`. `/api/[...path]` belongs to the proxy and a check enforces that it is the only route file under `web/src/app/api`. The Google redirect URI is therefore `<https://sil-clinic-booking.vercel.app/auth/callback/google`.>
- **Sessions:** stateless. With no database configured Better Auth runs in stateless mode with the session in a signed cookie (`session.cookieCache`, `strategy: "jwe"`, `refreshCache: true`, `account.storeStateStrategy: "cookie"`), so there is no auth database and no extra Neon load (<https://www.better-auth.com/docs/concepts/session-management>). The cost is that a session cannot be revoked early; the lifetime is short (7 days) and bumping `cookieCache.version` and redeploying signs everyone out.
- **Google:** one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel environment variables only (<https://www.better-auth.com/docs/authentication/google>). The consent screen is "External" and published, so any Google account can sign in; "Testing" mode would admit only listed users.
- **Roles:** admin if and only if the verified Google email is `developer.ericgitangu@gmail.com` and `email_verified` is true. Everyone else who signs in is a patient. The allowlist lives in server code, not in the client.
- **Patient ownership (the IDOR fix):**
  - A new table `patient_accounts(google_sub primary key, patient_id, email, created_at)`; a migration, expand-only.
  - On first sign-in the BFF calls `POST /internal/accounts/link`, which creates a patient from the Google name and records the mapping.
  - The BFF books, lists, cancels and reschedules only through `/internal/me/...` endpoints. The patient id is taken from the account mapping, never from anything the browser sends. An appointment that is not the caller's answers 404, not 403, so ids cannot be probed.
- **Internal endpoints:** everything under `/internal/*` is left out of the public OpenAPI document and the proxy refuses any `/api/internal/*` request. The BFF calls Cloud Run directly with its own identity token (ADR-0023) and adds a short-lived assertion, an HMAC over `{sub, email, role, exp}` made with `INTERNAL_SIGNING_KEY`, which the API verifies. Even a path-handling mistake in the proxy would then not expose them.
- **Secrets:** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET` and `INTERNAL_SIGNING_KEY` are set with `vercel env add` (sensitive) and never written to a file. `INTERNAL_SIGNING_KEY` is also the one new Secret Manager secret, because the API verifies with it.

## Consequences

- Good: the UI only ever shows a patient their own appointments, and the admin area has a real boundary.
- Good: the public API and Swagger keep working unauthenticated, as the brief says.
- Good: no auth database and no Auth.js beta dependency.
- Bad: the public REST API is still open, so the IDOR still exists there by design; it is closed in the BFF, not in the API. This is stated in the README.
- Bad: stateless sessions cannot be revoked individually.
- Bad: one more secret version in Secret Manager, about $0.06 a month on the shared account (ADR-0014).
- Bad: Google's consent screen needs a one-time manual setup in the Cloud console.

## Assessment line

"Patients can cancel" and "must not be available to others": a patient sees and changes only their own appointments, through the UI.

## Review trigger

A need to revoke a single session immediately, or per-clinic staff roles. Either moves sessions to a database and the admin allowlist to a role table.
