# ADR-0030: Staff roles granted by email, enforced in the app and again in the API

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0024](0024-google-sign-in-with-better-auth.md), [ADR-0010](0010-thin-nextjs-booking-ui.md)

## Status

Accepted. The admin app has three roles, held in a `staff_access` table and looked up on every request. The only configured identity is the owner.

**Build status (2026-10-18, main 4aef3b8): Shipped.** The admin app resolves a role (owner, admin, viewer) from `staff_access` on every request and the API checks it again per endpoint. The owner comes from `ADMIN_EMAILS`. There is no screen for the audit trail yet.

## Context

- [ADR-0024](0024-google-sign-in-with-better-auth.md) allowed one admin email, compared in server code. The engineer wants to let other people in at different levels without a redeploy, and to take access away at once.
- Sessions are stateless cookies ([ADR-0024](0024-google-sign-in-with-better-auth.md)), so a session cannot be revoked early. Whatever decides what a person may do therefore cannot live in the cookie.
- The public API stays unauthenticated, as the brief says. Everything under `/internal/admin/*` is reached only with the signed assertion, so the check can sit in the API itself.

## Considered options

1. Keep a list of emails in an environment variable. Changing it needs a redeploy and gives one level of access.
2. Put the role in the session cookie. Fast, but a revoke would wait for the cookie to expire.
3. A `staff_access` table in the existing database, resolved on every request, with the API checking the role again. Chosen.

## Decision

Option 3.

- **Roles.** `owner` can do everything and manage access. `admin` can use the dashboard and cancel or reschedule an appointment for a patient. `viewer` can only read the dashboard.
- **The owner is configuration, not data.** `ADMIN_EMAILS` (comma separated, the same value in the admin app and the API) lists the owners. They are always `owner`, have no row, and cannot be granted, changed or revoked through the API (`OWNER_PROTECTED`). Nobody else has access until the owner grants it.
- **Storage.** An expand-only migration adds `staff_access` (`email` citext, unique and lower-cased; `role` enum owner, admin, viewer; `granted_by`; `granted_at`; nullable `revoked_at`) and `staff_access_audit`. A revoke sets `revoked_at` and keeps the row, so nothing is ever deleted; granting the email again reactivates the row.
- **Resolved on every request.** The admin app reads the Google session, then asks the API what role the verified email holds (`GET /internal/admin/session`) and keeps the answer for the length of that request only. A revoke therefore applies to the person's next click, and a failed lookup is an error page, never a default role.
- **The API checks again.** Each endpoint names the roles it accepts. The assertion carries the role the app resolved; the API rejects it if the role is not allowed for that endpoint (403), and also if the database says the person no longer holds that role (403). So a stale or forged claim cannot widen access. Access management (`/internal/admin/access`: list, grant, change role, revoke) accepts the owner only. Cancelling and rescheduling for a patient (`/internal/admin/appointments/{id}/cancel` and `/reschedule`) accept owner and admin, and apply the same booking rules as the public endpoints.
- **Audit.** Every grant, change and revoke writes a `staff_access_audit` row in the same transaction: who, what, which email, old and new role, when.
- **What a person without a role sees.** A 403 page. A signed-out person is sent to sign-in. Access is refused at the page, not at the Google step, because the allow-list now lives in the database and the stateless sign-in has no database to ask.
- **UI.** The owner-only Access page adds a person with a role, changes a role and revokes, each behind a confirmation. Controls a role cannot use are not shown, and each is checked again on the server.

### Tests stand in for Google and for nothing else

The end-to-end tests run the production build of the admin app against the real API and Postgres. Sessions are made by Better Auth's own test plugin from the same options as the app, signed with a test `BETTER_AUTH_SECRET`; the app decodes them through its real cookie path, then looks the role up in the real table. Only Google's OAuth endpoints are replaced.

## Consequences

- Good: access is granted and withdrawn without a deploy, and a revoke is effective on the next request.
- Good: the API refuses a viewer who tries to cancel, whatever the web app does.
- Bad: one extra API call per page view to resolve the role (a primary-key lookup, and none for an owner).
- Bad: the sign-in itself is open to any Google account; only the pages and the API are gated. A stranger gets a session cookie that opens nothing.
- Bad: `CREATE EXTENSION citext` needs a role that may create extensions (the project owner can on Neon).
- Bad: there is no screen for the audit trail yet; it is read from the table.

## Assessment line

Section 1 "key decisions": who may see and change appointments, and how that is enforced.

## Review trigger

Per-doctor or per-clinic scoping, a need to see the audit trail in the app, or a move of sessions to a database.
