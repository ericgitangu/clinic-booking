# ADR-0029: The booking flow: server actions, an interim patient cookie, one human check per action

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0010](0010-thin-nextjs-booking-ui.md), [ADR-0022](0022-admin-auth-and-bot-protection.md)

## Status

Accepted. The booking screens live in `apps/booking`; the browser never talks to Cloud Run for them.

## Context

The patient screens need to list doctors, show free times, book, cancel and reschedule. Sign-in with Google arrives in a later slice, so for now nothing says who a visitor is. The API changes state, so it needs the human check from ADR-0022.

## Considered options

1. Server actions and server components calling the API, with a cookie until sign-in (chosen). No browser code holds a credential, and the human check runs where it cannot be skipped.
2. The browser calls `/api/*` through the proxy with a generated client. Fewer server files, but the human check would have to live in the proxy for every route.
3. Wait for sign-in before building any booking screen. Cleaner identity, but nothing to show for the booking half of the brief.

## Decision

- **Server components read, server actions write.** Pages fetch through `callApi` in `@clinic/api`, which does what the `/api` proxy does for the browser: mint a Cloud Run ID token on Vercel and send it in `x-serverless-authorization`. Responses are parsed with zod schemas that a test compares with `contracts/openapi.json`, so the API and the screens cannot drift apart unnoticed. The schemas are written by hand, not generated; the test is what keeps them honest.
- **One human check per action, on the screens.** Booking, cancelling and rescheduling each get their own reCAPTCHA Enterprise token with a distinct action name. The server creates an assessment as `clinic-recaptcha` (reached through the Vercel identity, no key stored) and rejects a missing or invalid token, a token issued for another action, and a score below the minimum (0.5 unless `RECAPTCHA_MIN_SCORE` says otherwise). If Google cannot be reached, or the keys are not configured, the request is refused. The check can be switched off only with `RECAPTCHA_ENFORCE=false` together with `NODE_ENV=test` or `E2E=1`, and never when `VERCEL_ENV` is production; a unit test covers each combination.
- **Interim identity: a signed cookie.** After a booking the browser remembers the patient id and name in an httpOnly cookie signed with HMAC-SHA256 under a server-only secret, `CLINIC_COOKIE_SECRET` (at least 32 characters). A value the server did not issue is ignored. "My appointments", cancel, reschedule and the confirmation page work from it, and each first checks that the appointment belongs to that patient. If the secret is missing, booking is refused before anything is created. The cookie is not bound to a server session, so someone who copies the whole cookie from a browser can use it until it expires (180 days). Sign-in replaces it.
- **A taken slot is a normal outcome.** On `SLOT_TAKEN` the action returns the next free times for that doctor and the screen offers them, one tap each.
- **My appointments lists upcoming appointments only.** The patient endpoint does not return cancelled appointments, so the screen does not pretend to show them.
- **A duplicate phone number gets a generic message** ("We could not create that patient...") on the screens.
- **Tests run twice.** `apps/booking/e2e/booking.spec.ts` runs against an in-memory stand-in API (`e2e/fake-api.mjs`) for the fast run, and the same scenarios run in CI (job `e2e-real`) against the real API and database from `docker-compose` with migrations and seed. Times are found through the API, so weekends and closed days are skipped without a fixed date.

### What this does not protect

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
