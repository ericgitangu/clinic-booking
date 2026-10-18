# ADR-0029: The booking flow: server actions, Google sign-in, one human check per action

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0010](0010-thin-nextjs-booking-ui.md), [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status

Accepted. The booking screens live in `apps/booking`; the browser never talks to Cloud Run for them. Amended 2026-10-18: patients sign in with Google (ADR-0024) and the interim cookie is gone.

**Build status (2026-10-18, main 4aef3b8): Shipped.** Server components read and server actions write, with Google sign-in, per-action reCAPTCHA and the real-API e2e job.

## Context

The patient screens need to list doctors, show free times, book, cancel and reschedule. Sign-in with Google ([ADR-0024](0024-google-sign-in-with-better-auth.md)) says who the visitor is. The API changes state, so it also needs the human check from ADR-0022.

## Considered options

1. Server actions and server components calling the API, with Google sign-in deciding who the patient is (chosen). No browser code holds a credential, and the human check runs on the server for every screen flow.
2. The browser calls `/api/*` through the proxy with a generated client. Fewer server files, but the human check would have to live in the proxy for every route.
3. Wait for sign-in before building any booking screen. Cleaner identity, but nothing to show for the booking half of the brief.

## Decision

- **Server components read, server actions write.** Pages fetch through `callApi` in `@clinic/api`, which does what the `/api` proxy does for the browser: mint a Cloud Run ID token on Vercel and send it in `x-serverless-authorization`. The types, the zod schemas and the SDK are generated from `contracts/openapi.json` with `@hey-api/openapi-ts` (ADR-0011): nothing under `packages/api/src/generated` is edited by hand, `make gen-client` rewrites it, and the lint job fails if it differs from a fresh run. Every call checks its request against the generated schema before sending, and its response against the schema for that operation. An error body is checked against the generated Problem schema and its `code` against the generated code list. Anything that does not match is logged as a `contract_violation` event (operation, status and the paths of the zod issues, no values) and shown as a generic failure. The contract declares problem responses without a schema, so the generated Problem component is used for every error status.
- **One human check per action, on the screens.** Booking, cancelling and rescheduling each get their own reCAPTCHA Enterprise token with a distinct action name. The server creates an assessment as `clinic-recaptcha` (reached through the Vercel identity, no key stored) and rejects a missing or invalid token, a token issued for another action, and a score below the minimum (0.5 unless `RECAPTCHA_MIN_SCORE` says otherwise). If Google cannot be reached, or the keys are not configured, the request is refused. The check can be switched off only with `RECAPTCHA_ENFORCE=false` together with `NODE_ENV=test` or `E2E=1`, and never when `VERCEL_ENV` is production; a unit test covers each combination.
- **Identity: Google sign-in.** The app has its own Better Auth instance (stateless, encrypted session cookie, base path `/auth`, no auth database), as the admin app does. Booking, My appointments, cancel and reschedule need a signed-in person with a verified email. The server first calls the idempotent `POST /internal/accounts/link`, which creates a patient for that Google subject on the first call and returns the same patient on every later one (it never adopts an existing patient by email or phone), and then books through `/internal/me/appointments`. Every `/internal` call carries the signed assertion for the signed-in person. The signed identity is Google's own subject, read from the account cookie (Better Auth makes up a different user id on every instance that has not seen the person, so that id is never used), and it carries whether Google verified the email: the API refuses an unverified address on every patient route. The link answers 201 when it creates the patient and 200 when it already exists, and a Google display name shorter than two characters falls back to the part of the email before the @. The patient id is never taken from the browser: the API derives it from the account, and an appointment that is not the caller's answers 404, the same as one that does not exist. Doctors and free times stay public. The previous signed-cookie identity, and the `CLINIC_COOKIE_SECRET` it needed, are removed.
- **A taken slot is a normal outcome.** On `SLOT_TAKEN` the action returns the next free times for that doctor and the screen offers them, one tap each.
- **My appointments lists upcoming appointments only.** The patient endpoint does not return cancelled appointments, so the screen does not pretend to show them.
- **A duplicate phone number gets a generic message** ("We could not create that patient...") on the screens.
- **Everything runs against the real API.** The browser scenarios in `apps/booking/e2e` and `packages/api/tests/real-api.test.ts` run in CI (job `e2e-real`) against the real API and database from `docker-compose` with migrations and seed (`make e2e` does the same locally). There is no stand-in for our own API. The only stand-in is in `real-api.test.ts`, where a real response is damaged on its way back to prove contract drift is caught, and it is labelled there; Google is the only third party and the human check is covered by unit tests of its reject paths. Times are found through the API, so weekends and closed days are skipped without a fixed date.

### What this does not protect

The public REST API at `/api` is unauthenticated on purpose: the brief asks for a public REST API and reviewers try it through Swagger, so Try it out works. It is rate limited per IP, and reads of one patient's appointments rely on unguessable UUIDs. The reCAPTCHA check, the patient-ownership check and the sign-in are not applied there: they protect the web screens (and, for sign-in, the `/internal` routes), not the public API. So anyone who calls the API directly with an appointment or patient id can read or change it, and a duplicate phone on patient creation still tells an API caller that the number exists. This is accepted debt, recorded in ADR-0012 and ADR-0022 and in README section 10; the review trigger is API authentication with Google sign-in.

## Consequences

- Good: no booking secret reaches the browser, and the screens cannot be driven without passing the human check in production.
- Good: the failure messages are written once, in `lib/problems.ts`, and tested for plain wording.
- Bad: the public API stays open, as described above.
- Bad: sessions are stateless, so one cannot be revoked before it expires (seven days).
- Bad: booking now needs a Google account; there is no guest booking.
- Bad: the generated client can drift from the real API; the real-API job is what catches that (there is no stand-in API).
- Bad: the human check on a live deploy cannot be rehearsed on a preview, because only the production Vercel subject is trusted by Google. A preview cannot book at all, since the check is on and cannot reach Google there.

## Assessment line

Section 1 "key decisions, trade-offs": how a patient books safely: a signed-in account plus a human check per action.

## Review trigger

A need to revoke a single session at once, guest booking, or any real patient data (the demo data policy needs a new decision).
