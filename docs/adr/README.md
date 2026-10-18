# Architecture Decision Records

MADR-style records for the clinic booking system. Every ADR has the same seven sections: Status, Context, Considered options, Decision, Consequences, Assessment line, Review trigger. ADRs marked "stretch" describe the gated tier that starts only after Gate B; if an item does not ship, its ADR stays as the design record and the README says it was not shipped.

| ADR | Title | Status | Brief line it serves |
|---|---|---|---|
| [0001](0001-monorepo-layout-and-task-runner.md) | Monorepo layout and task runner | Accepted | "sensible structure" |
| [0002](0002-fastapi-single-system-of-record.md) | FastAPI as the single system of record (no Go service in the write path) | Accepted (a read-only Go gateway for the admin feed is optional, ADR-0021) | "REST API in FastAPI, DRF or Go" |
| [0003](0003-double-booking-partial-unique-index.md) | Double-booking prevention with a partial unique index | Accepted | "not taken"; "must not be available to others" |
| [0004](0004-computed-slots.md) | Slots are computed, not materialized | Accepted | "set working hours ... 30-minute slots" |
| [0005](0005-time-and-timezone-model.md) | Time and timezone model | Accepted | "on a day"; "not in past" |
| [0006](0006-problem-details-error-model.md) | Error model (RFC 9457) and status rule | Accepted | "meaningful errors + correct HTTP status codes" |
| [0007](0007-api-style-rest-openapi.md) | REST + OpenAPI; tRPC/GraphQL/gRPC verdict | Accepted | Section 2 endpoint list |
| [0008](0008-appointment-lifecycle-and-reschedule.md) | Lifecycle, reschedule atomicity, concurrent updates | Accepted | "old slot freed ... error if cancelled" |
| [0009](0009-realtime-polling-now-sse-later.md) | Realtime: polling for patients; an optional SSE gateway for admins | Accepted (the admin feed is optional and comes after the dashboard) | "must not be available to others" (UX) |
| [0010](0010-thin-nextjs-booking-ui.md) | The Next.js web app: booking UI, admin dashboard, PWA | Accepted (amended 2026-10-17: full frontend in scope, droppable slices) | "sees free slots ... books it ... can cancel" |
| [0011](0011-openapi-codegen-contract.md) | pydantic → OpenAPI → TS/zod/TanStack codegen | Accepted (with UI) | "sensible structure" |
| [0012](0012-identity-and-abuse-controls-deferred.md) | Identity and abuse controls: public API open; sign-in in the web app | Accepted (amended 2026-10-17: sign-in built in the web app, ADR-0024; the public API stays open) | "Patients can cancel"; "book online" |
| [0013](0013-idempotency-keys.md) | Idempotency keys on POST /appointments | Accepted (T2, cut 2nd) | "must not be available to others" (retry safety) |
| [0014](0014-hosting-region-and-cost.md) | Hosting, region and cost | Accepted (amended: us-east4, $0 proof) | "Deploy to any cloud, public URL" |
| [0015](0015-database-roles-and-migrations.md) | Database roles and migration safety | Accepted | Section 3 "how it deploys" |
| [0016](0016-cicd-circleci-keyless-deploy.md) | CI/CD on CircleCI with keyless deploy | Accepted | Section 3 CI/CD |
| [0017](0017-security-testing.md) | Security testing in the pipeline | Accepted (ZAP cut 3rd) | Section 3 "what the pipeline does" |
| [0018](0018-testing-strategy.md) | Testing strategy and race-proof harness | Accepted | "basic test coverage of booking logic" |
| [0019](0019-observability.md) | Observability | Accepted | "meaningful errors" (request_id) |
| [0020](0020-git-hygiene-and-ai-disclosure.md) | Git hygiene and AI-usage disclosure | Accepted | Section 4 "Honesty matters" |
| [0021](0021-go-realtime-gateway.md) | A Go SSE gateway for the admin realtime feed | Accepted (optional, after the admin dashboard); marked superseded by ADR-0031 on 2026-10-18 and reinstated by the engineer on 2026-10-19 | Section 1 "components, key decisions, trade-offs" |
| [0022](0022-admin-auth-and-bot-protection.md) | Admin OAuth and UI bot protection (original design) | Accepted (sign-in superseded by ADR-0024; the bot check stays cut) | "meaningful errors + correct HTTP status codes"; "book online" |
| [0023](0023-zero-cost-edge-front-door.md) | Zero-cost edge: IAM-gated Cloud Run behind a Vercel front door in North America | Accepted, decided by the engineer 2026-10-16 (; one Vercel project `web`; amends 0010, 0014, 0016, 0022; implementation hardened by the hosting lock review) | "Deploy to any cloud, public URL" under the $0 rule |
| [0024](0024-google-sign-in-with-better-auth.md) | Google sign-in for patients and admin, with Better Auth | Accepted, decided by the engineer 2026-10-17 | "Patients can cancel"; "must not be available to others" |
| [0025](0025-email-with-resend.md) | Booking emails and reminders with Resend | Accepted, decided by the engineer 2026-10-17 | "Patients can cancel" |
| [0026](0026-branding-and-seo.md) | Branding and SEO | Accepted, decided by the engineer 2026-10-17 | Section 4 "Honesty matters" |
| [0027](0027-two-apps-in-a-workspace.md) | Two web apps in one workspace: booking and admin | Accepted, decided by the engineer 2026-10-17 | Section 1 "components, key decisions, trade-offs" |
| [0028](0028-public-hostnames.md) | Public hostnames on ericgitangu.com | Accepted, decided by the engineer 2026-10-17 | Section 1 "key decisions" |
| [0029](0029-booking-flow.md) | The booking flow: server actions, Google sign-in, one human check per action | Accepted, decided by the engineer 2026-10-17 | Section 1 "key decisions" |
| [0030](0030-staff-roles-and-access.md) | Staff roles granted by email, enforced in the app and again in the API | Accepted, decided by the engineer 2026-10-17 | Section 1 "key decisions" |
| [0031](0031-realtime-push-via-ably-sse.md) | Realtime push via Ably SSE | Accepted, decided by the engineer 2026-10-18; built for patients (admin feed: see 0021) | Section 1 "components, key decisions, trade-offs" |
| [0032](0032-admin-live-feed-descoped.md) | The admin live feed is descoped for this submission | Accepted, decided by the engineer 2026-10-18; reversed by the engineer 2026-10-19 (built with the Go gateway) | Section 1 "key decisions, trade-offs" |
| [0033](0033-staff-crud-veto-and-invites.md) | Staff appointment CRUD, patient-change veto and email invites | Accepted, decided by the engineer 2026-10-18; pending build | Section 1 "key decisions, trade-offs" |

**Adding an ADR.** Take the next free number and use the same seven headings. Link it from this table. `make lint` checks the markdown.

## Build status

Checked against `main` (748d7d8) on 2026-10-18 (read, not run). Words used: shipped, partly shipped, declared (decided, in an open PR), descoped, superseded. Each ADR also carries a "Build status" line under its Status. Rows touched by the Go gateway (PR 71, 2026-10-19) carry that date; the rest were checked on 2026-10-18. "Accepted" above means decided, not necessarily built.

| ADR | Build status |
|---|---|
| 0001 | Shipped, Go module built (PR 71) |
| 0002 | Shipped; the only Go is the read-only gateway (PR 71) |
| 0003 | Shipped |
| 0004 | Shipped (#31) |
| 0005 | Shipped (#31) |
| 0006 | Shipped (#31) |
| 0007 | Shipped |
| 0008 | Shipped |
| 0009 | Shipped for patients; admin feed built with the Go gateway (PR 71) |
| 0010 | Partly shipped |
| 0011 | Shipped |
| 0012 | Shipped in the web layer |
| 0013 | Shipped (#31) |
| 0014 | Mostly shipped |
| 0015 | Shipped; the gateway role is pinned by migration 0014 (PR 71) |
| 0016 | Shipped, text amended; the Go lane is built (PR 71) |
| 0017 | Shipped |
| 0018 | Shipped, text amended |
| 0019 | Shipped |
| 0020 | Partly shipped |
| 0021 | Built (PR 71), reinstated 2026-10-19 |
| 0022 | Superseded in part |
| 0023 | Shipped for the API |
| 0024 | Shipped |
| 0025 | Declared, not on main (PR #27, open) |
| 0026 | Mostly shipped |
| 0027 | Shipped |
| 0028 | Mostly shipped |
| 0029 | Shipped |
| 0030 | Shipped |
| 0031 | Shipped for patients |
| 0032 | Reversed 2026-10-19; the feed is built (PR 71) |
| 0033 | Declared, not built (three PRs pending) |
