# Architecture Decision Records

MADR-style records for the clinic booking system. Every ADR has the same seven sections: Status, Context, Considered options, Decision, Consequences, Assessment line, Review trigger. The master plan is in [`../architecture/PLAN.md`](../architecture/PLAN.md). ADRs marked "stretch" describe the gated tier that starts only after Gate B (PLAN.md §0); if an item does not ship, its ADR stays as the design record and the README says it was not shipped.

| ADR | Title | Status | Brief line it serves |
|---|---|---|---|
| [0001](0001-monorepo-layout-and-task-runner.md) | Monorepo layout and task runner | Accepted | "sensible structure" |
| [0002](0002-fastapi-single-system-of-record.md) | FastAPI as the single system of record (no Go service in the write path) | Accepted (amended for stretch S1) | "REST API in FastAPI, DRF or Go" |
| [0003](0003-double-booking-partial-unique-index.md) | Double-booking prevention with a partial unique index | Accepted | "not taken"; "must not be available to others" |
| [0004](0004-computed-slots.md) | Slots are computed, not materialized | Accepted | "set working hours ... 30-minute slots" |
| [0005](0005-time-and-timezone-model.md) | Time and timezone model | Accepted | "on a day"; "not in past" |
| [0006](0006-problem-details-error-model.md) | Error model (RFC 9457) and status rule | Accepted | "meaningful errors + correct HTTP status codes" |
| [0007](0007-api-style-rest-openapi.md) | REST + OpenAPI; tRPC/GraphQL/gRPC verdict | Accepted | Section 2 endpoint list |
| [0008](0008-appointment-lifecycle-and-reschedule.md) | Lifecycle, reschedule atomicity, concurrent updates | Accepted | "old slot freed ... error if cancelled" |
| [0009](0009-realtime-polling-now-sse-later.md) | Realtime: polling for patients; SSE via a Go gateway for admins as gated stretch | Accepted (supersedes its own SSE deferral; admin SSE is stretch S1) | "must not be available to others" (UX) |
| [0010](0010-thin-nextjs-booking-ui.md) | Thin Next.js patient booking UI, plus stretch PWA, theme and /admin | Accepted (booking pages T2, cut 1st; the `web` project's proxy and landing page are lean core since PLAN §12.3; stretch S1-S4 on top) | "sees free slots ... books it ... can cancel" |
| [0011](0011-openapi-codegen-contract.md) | pydantic → OpenAPI → TS/zod/TanStack codegen | Accepted (with UI) | "sensible structure" |
| [0012](0012-identity-and-abuse-controls-deferred.md) | Identity and abuse controls: patient auth deferred; admin OAuth and Turnstile as gated stretch | Accepted (amended) | "Patients can cancel"; "book online" |
| [0013](0013-idempotency-keys.md) | Idempotency keys on POST /appointments | Accepted (T2, cut 2nd) | "must not be available to others" (retry safety) |
| [0014](0014-hosting-region-and-cost.md) | Hosting, region and cost | Accepted (amended: us-east4, $0 proof) | "Deploy to any cloud, public URL" |
| [0015](0015-database-roles-and-migrations.md) | Database roles and migration safety | Accepted | Section 3 "how it deploys" |
| [0016](0016-cicd-circleci-keyless-deploy.md) | CI/CD on CircleCI with keyless deploy | Accepted | Section 3 CI/CD |
| [0017](0017-security-testing.md) | Security testing in the pipeline | Accepted (ZAP cut 3rd) | Section 3 "what the pipeline does" |
| [0018](0018-testing-strategy.md) | Testing strategy and race-proof harness | Accepted | "basic test coverage of booking logic" |
| [0019](0019-observability.md) | Observability | Accepted | "meaningful errors" (request_id) |
| [0020](0020-git-hygiene-and-ai-disclosure.md) | Git hygiene and AI-usage disclosure | Accepted | Section 4 "Honesty matters" |
| [0021](0021-go-realtime-gateway.md) | A Go SSE gateway for the admin realtime feed | Accepted (stretch S1, cut last of S1-S4) | Section 1 "components, key decisions, trade-offs" |
| [0022](0022-admin-auth-and-bot-protection.md) | Admin-only OAuth and UI bot protection | Accepted (stretch S3 cut 2nd, S4 cut 1st) | "meaningful errors + correct HTTP status codes"; "book online" |
| [0023](0023-zero-cost-edge-front-door.md) | Zero-cost edge: IAM-gated Cloud Run behind a Vercel front door in North America | Accepted, decided by the engineer 2026-10-16 (Q5; one Vercel project `web`; amends 0010, 0014, 0016, 0022; implementation hardened by the hosting lock review, PLAN.md §12.4) | "Deploy to any cloud, public URL" under the $0 rule |

**Adding an ADR.** Take the next free number and use the same seven headings. Link it from this table and from the relevant section of `PLAN.md`. `make docs-check` enforces the headings and the links.
