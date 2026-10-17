# ADR-0029: The booking flow: server actions, an interim patient cookie, one human check per action

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0010](0010-thin-nextjs-booking-ui.md), [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status

Accepted. The booking screens live in `apps/booking`; the browser never talks to Cloud Run for them.

## Context

The patient screens need to list doctors, show free times, book, cancel and reschedule. Sign-in with Google arrives in a later slice, so for now nothing says who a visitor is. The API changes state, so it needs the human check from ADR-0022.

## Considered options

1. Server actions and server components calling the API, with a cookie until sign-in (chosen). No browser code holds a credential, and the human check runs on the server for every screen flow.
2. The browser calls `/api/*` through the proxy with a generated client. Fewer server files, but the human check would have to live in the proxy for every route.
3. Wait for sign-in before building any booking screen. Cleaner identity, but nothing to show for the booking half of the brief.

## Decision

- **Server components read, server actions write.** Pages fetch through `callApi` in `@clinic/api`, which does what the `/api` proxy does for the browser: mint a Cloud Run ID token on Vercel and send it in `x-serverless-authorization`. The types, the zod schemas and the SDK are generated from `contracts/openapi.json` with `@hey-api/openapi-ts` (ADR-0011): nothing under `packages/api/src/generated` is edited by hand, `make gen-client` rewrites it, and the lint job fails if it differs from a fresh run. Every call checks its request against the generated schema before sending, and its response against the schema for that operation. An error body is checked against the generated Problem schema and its `code` against the generated code list. Anything that does not match is logged as a `contract_violation` event (operation, status and the paths of the zod issues, no values) and shown as a generic failure. The contract declares problem responses without a schema, so the generated Problem component is used for every error status.
- **One human check per action, on the screens.** Booking, cancelling and rescheduling each get their own reCAPTCHA Enterprise token with a distinct action name. The server creates an assessment as `clinic-recaptcha` (reached through the Vercel identity, no key stored) and rejects a missing or invalid token, a token issued for another action, and a score below the minimum (0.5 unless `RECAPTCHA_MIN_SCORE` says otherwise). If Google cannot be reached, or the keys are not configured, the request is refused. The check can be switched off only with `RECAPTCHA_ENFORCE=false` together with `NODE_ENV=test` or `E2E=1`, and never when `VERCEL_ENV` is production; a unit test covers each combination.
- **Interim identity: a signed cookie.** After a booking the browser remembers the patient id and name in an httpOnly cookie signed with HMAC-SHA256 under a server-only secret, `CLINIC_COOKIE_SECRET` (at least 32 characters). A value the server did not issue is ignored. "My appointments", cancel, reschedule and the confirmation page work from it, and each first checks that the appointment belongs to that patient. If the secret is missing, booking is refused before anything is created. The cookie is not bound to a server session, so someone who copies the whole cookie from a browser can use it until it expires (180 days). Sign-in replaces it.
- **A taken slot is a normal outcome.** On `SLOT_TAKEN` the action returns the next free times for that doctor and the screen offers them, one tap each.
- **My appointments lists upcoming appointments only.** The patient endpoint does not return cancelled appointments, so the screen does not pretend to show them.
- **A duplicate phone number gets a generic message** ("We could not create that patient...") on the screens.
- **Everything runs against the real API.** The browser scenarios in `apps/booking/e2e` and `packages/api/tests/real-api.test.ts` run in CI (job `e2e-real`) against the real API and database from `docker-compose` with migrations and seed (`make e2e` does the same locally). There is no stand-in for our own API. The only stand-in is in `real-api.test.ts`, where a real response is damaged on its way back to prove contract drift is caught, and it is labelled there; Google is the only third party and the human check is covered by unit tests of its reject paths. Times are found through the API, so weekends and closed days are skipped without a fixed date.

### What this does not protect

reCAPTCHA and the patient-ownership check protect the web UI flows. The public REST API at `/api` is intentionally unauthenticated, as the brief requires, so Swagger's Try it out works. It is rate-limited per IP, and patient-scoped reads rely on unguessable UUIDs. This is accepted debt; the review trigger is API authentication with Google sign-in.

The public REST API at `/api` is unauthenticated on purpose: the brief asks for a public REST API and reviewers try it through Swagger. It is rate limited per IP, reads of one patient's appointments rely on unguessable UUIDs, and the reCAPTCHA check and the cookie are not applied there. So the checks above protect the web screens only; anyone who calls the API directly with an appointment or patient id can read or change it, and a duplicate phone on patient creation still tells an API caller that the number exists. This is accepted debt, recorded in ADR-0012 and ADR-0022 and in README section 10. API authentication arrives with Google sign-in (ADR-0024).

## Consequences

- Good: no booking secret reaches the browser, and the screens cannot be driven without passing the human check in production.
- Good: the failure messages are written once, in `lib/problems.ts`, and tested for plain wording.
- Bad: the public API stays open, as described above.
- Bad: until sign-in lands, a copied cookie grants access to one patient's appointments. Accepted for a demonstration with synthetic data.
- Bad: the stand-in API can drift from the real one; the real-API job is what catches that.
- Bad: the human check on a live deploy cannot be rehearsed on a preview, because only the production Vercel subject is trusted by Google. A preview cannot book at all, since the check is on and cannot reach Google there.

## Assessment line

Section 1 "key decisions, trade-offs": how a patient books safely before accounts exist.

## Review trigger

Sign-in shipping (remove the cookie and add API authentication), or any real patient data (the cookie and the demo data policy both need a new decision).
