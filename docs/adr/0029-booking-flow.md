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
- **One human check per action.** Booking, cancelling and rescheduling each get their own reCAPTCHA Enterprise token with a distinct action name. The server creates an assessment as `clinic-recaptcha` (reached through the Vercel identity, no key stored) and rejects a missing or invalid token, a token issued for another action, and a score below the minimum (0.5 unless `RECAPTCHA_MIN_SCORE` says otherwise). If Google cannot be reached the request fails closed. Production always checks; `RECAPTCHA_ENFORCE=false` works only outside production, for previews and local runs that have no Google identity.
- **Interim identity: a cookie.** After a booking the browser remembers the patient id and name in an httpOnly cookie. "My appointments", cancel and reschedule work from it, and every change first checks that the appointment belongs to that patient. The id is a random UUID, so the cookie works like an unguessable link; it is not signed. Anyone who copies it sees that patient's appointments. Sign-in replaces it.
- **A taken slot is a normal outcome.** On `SLOT_TAKEN` the action returns the next free times for that doctor and the screen offers them, one tap each.
- **Tests run against a stand-in API.** `apps/booking/e2e/fake-api.mjs` implements the booking rules for the cases the end-to-end tests cover, so every error path can be driven without a database. The real API is covered by its own tests and by `scripts/verify_claims.py`.

## Consequences

- Good: no booking secret reaches the browser; the check cannot be skipped by calling the API directly from a page.
- Good: the failure messages are written once, in `lib/problems.ts`, and tested for plain wording.
- Bad: until sign-in lands, a copied cookie grants access to one patient's appointments. Accepted for a demonstration with synthetic data, and listed in the README's debt.
- Bad: the stand-in API can drift from the real one. The cases it covers are few and named in the file.
- Bad: the human check on a live deploy cannot be rehearsed on a preview, because only the production Vercel subject is trusted by Google.

## Assessment line

Section 1 "key decisions, trade-offs": how a patient books safely before accounts exist.

## Review trigger

Sign-in shipping (remove the cookie), or any real patient data (the cookie and the demo data policy both need a new decision).
