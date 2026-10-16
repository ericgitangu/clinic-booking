# Clinic Booking: Master Plan

Status: Accepted (final, post red-team; amended 2026-10-16 with a gated stretch tier, §12.1, and its review, §12.2; amended again 2026-10-16 by the $0 cost audit, §13 and ADR-0023; amended again 2026-10-16 by the engineer's final hosting decision, Vercel for the frontend and GCP for the backend in a single Vercel project, §12.3, and by its hosting lock review, §12.4) · Date: 2026-10-16 · Deadline: 2026-10-22 17:00 EAT

This is the end-to-end plan for the Savannah Informatics backend take-home. It has two jobs. It tells a reviewer how we reasoned. It also gives anyone executing a work package (§8) enough detail to build it exactly as written, without reopening decisions. Architectural decisions are recorded as ADRs in [`docs/adr/`](../adr/README.md). This file links to them rather than repeating them.

Rules for reading this document:
- **Empirical vs deduced.** A claim is marked **verified (date, how)** only when we observed it. Anything marked **unverified** is a hypothesis, and it names the work package that has to settle it. A deduction is never presented as fact.
- **Scope rule.** Every item outside the brief cites the assessment line it strengthens. If it cannot cite one, it is deferred (§0, ADR index).

---

# 0. Executive summary

**What we ship.**
- **API.** One FastAPI service, `clinic-api`, which is the system of record. It runs on PostgreSQL 17 and exposes REST paths that match the brief exactly. Public Swagger and ReDoc docs.
- **Runtime.** Cloud Run (scale-to-zero, ~~europe-west3~~ **us-east4**) with Neon Free Postgres (~~aws-eu-central-1~~ **aws-us-east-1**), reached only through the front door: proxy route handlers inside the single Vercel project, the Next.js app in `web/`, running in `iad1`; Cloud Run itself is IAM-gated (amended by the $0 audit, [ADR-0023](../adr/0023-zero-cost-edge-front-door.md); one Vercel project by the engineer's decision, §12.3). Vercel hosts the frontend and GCP hosts the backend. The public URL is the web project's URL: REST under `/api`, Swagger at `/docs`.
- **Cost.** $0, proven per resource against official free tiers in §13, with hard caps where the platform has them and a `cost-check` CI job where it does not.
- **CI/CD.** CircleCI tests every PR. On merge to `main` it deploys keyless (OIDC to Workload Identity Federation), runs migrations first, deploys a no-traffic tagged revision, smoke-tests that exact revision, and promotes it by tag.
- **Web project (lean core since §12.3).** The Next.js 16 app in `web/` always ships, because its proxy route handler (`/api/*`), the static documentation routes (`/docs`, `/redoc`, `/openapi.json`, built from the committed contract and never fetched from Cloud Run since the hosting lock review, §12.4) and a minimal landing page linking to Swagger are the public URL the brief requires. A credential-free `smoke-public` job checks that public path on every release.
- **UI (optional tier).** Thin patient booking pages inside that same project, consuming a client generated from the API's OpenAPI document. They are the first thing cut if time runs short; cutting them leaves the proxy, the landing page and the public URL in place.
- **Stretch tier (gated, may ship partly or not at all).** Starts only after Gate B passes. In priority order: S1 a Go SSE gateway feeding a live admin dashboard, S2 a PWA app shell plus the dark/light theme, S3 Google OAuth for the admin area only, S4 Cloudflare Turnstile on the UI booking route. Each item is independently droppable and never changes the semantics of the required endpoints. See "Stretch tier" below and §8.

**The story a reviewer should take away.**
> "Two patients can never hold the same slot. That guarantee comes from a Postgres partial unique index, not from application code. We show the race harness really races in two ways. First, a naive check-then-insert implementation run through the *identical* harness double-books. Second, during the real run, a lock sampler sees many transactions blocked on the unique index at the same moment. Our implementation still yields exactly one 201 and 24 409s. Slots are computed from working hours, never stored. Every error is RFC 9457 problem+json with a stable code, chosen by a written 422/409/404 rule. CircleCI tests every PR. A merge to `main` deploys keyless, migrations first, and promotes only the revision that passed the same smoke script reviewers can run. We considered a long list of extras and built few of them. The README names each deferred one and what would bring it back."

**Scope tiers**

| Tier | Items |
|---|---|
| **T0 required** | The 4 required endpoints. The double-booking constraint. Computed slots. The timezone model. problem+json errors. Layered structure. Unit, integration and race tests. Dockerfile. Cloud Run deploy at a public URL (served by the `web/` Vercel project's proxy route handlers and landing page, §12.3). CircleCI test-on-PR and deploy-on-merge. README covering design, ambiguities, trade-offs and CI/CD. A truthful AI reflection. |
| **T1 bonus** | `GET /patients/{id}/appointments` (upcoming, sorted). No booking within 60 minutes of now, enforced on POST, on reschedule and in availability. |
| **T2 built (small, cheap, each cites a brief line)** | `appointment_events` audit table. Public Swagger/ReDoc. Problem catalogue at `/problems`. Schemathesis contract tests. OIDC/WIF keyless deploy with tagged smoke and promote-by-tag. Terraform foundation. docker-compose, Makefile, husky. Security gates (ruff-S, semgrep, pip-audit, gitleaks, trivy, ZAP API scan against an ephemeral stack). JSON logs. Separate DB roles. Idempotency keys. Next.js booking UI pages with a codegen drift gate. |
| **Stretch (gated on Gate B; S1-S4, cut S4 first)** | S1 Go SSE gateway `clinic-realtime` + `GET /admin/metrics` + live recharts `/admin` dashboard. S2 PWA app shell (Serwist, network-only for all data) + dark/light theme. S3 Google OAuth (Auth.js) for the admin area only. S4 Cloudflare Turnstile on the UI booking route. See the stretch table below, ADR-0009, ADR-0010, ADR-0021 and ADR-0022. **Amended 2026-10-16: S3 (OAuth) and S4 (Turnstile) are cut by the engineer 2026-10-16, deferred with review trigger (ADR-0022); their design text is kept. S1 and S2 run only after Gate B and only if budget allows.** |
| **Deferred (designed in one paragraph each, not built)** | SSE live availability for patients (the patient UI keeps polling), API auth for patients (with demo tokens), rate limiting beyond the per-IP SSE connection cap, booking cap, bot protection enforced at the API itself (direct API calls stay unprotected). See ADR-0009, ADR-0012 and ADR-0022. |
| **Rejected** | tRPC, GraphQL, native gRPC, ConnectRPC, end-to-end h2c, a Go service in the write path or as the system of record, moon, a PWA that caches API responses, Upstash Redis (until the fan-out trigger in ADR-0021), Postgres LISTEN on Neon, Vercel rewrite proxy, Neon CI branches, OpenTelemetry SDK, materialized slot table, EXCLUDE/gist (for now), doctor time-off, variable slot lengths, reCAPTCHA v3, managed realtime (Pusher/Ably). Each has a review trigger in its ADR. |
| **Cut for cost ($0 rule, §13)** | Europe hosting (europe-west3 Tier 2 compute; Europe and Africa egress billed from byte 0), a public `allUsers` Cloud Run invoker (and its two equivalents, `--allow-unauthenticated` and `--no-invoker-iam-check`), CPU always allocated, VPC egress and GPUs, BuildKit provenance/SBOM attestations, ~~uncached doc routes~~ doc routes that reach Cloud Run at all (static since §12.4), Cloud Run manual scaling, `services replace` and worker pools (§12.4), an unmetered public stream (§12.4), Artifact Analysis / container scanning API, Cloud Build and `gcloud run deploy --source`, a Terraform state bucket outside the Cloud Storage Always Free regions, CircleCI Docker layer caching and large/Gen2 resource classes, Vercel image optimization, uptime pingers against prod, more than 6 active secret versions. Reasons and the replacement for each in §13.6. |

**T2 justification and cut order** (the guardrail check)

| T2 item | Brief line it strengthens | Cut order (1 = cut first) |
|---|---|---|
| Next.js booking UI pages + codegen drift gate (WP-15, WP-16; never the proxy or landing page from WP-11 Part C, §12.3) | "A patient sees free slots for a doctor on a day, picks one, books it ... Patients can cancel" | 1 |
| Idempotency-Key on POST (WP-14) | "Once booked the slot must not be available to others": a network retry must not tell the real booker the slot is taken | 2 |
| ZAP API scan job (part of WP-13) | Section 3 "what the pipeline does" | 3 |
| Terraform (falls back to the `infra/bootstrap.sh` gcloud script) | Section 3 "which branch deploys and how" | 4 |
| Schemathesis, problem catalogue, Swagger, audit events, OIDC/WIF, tagged smoke, Makefile/compose/husky, SAST/SCA/secrets/image scan, JSON logs, DB roles | "meaningful errors + correct HTTP status codes"; "sensible structure"; Section 3 | never cut: cheap, built alongside the core |

**Stretch tier** (added by the engineer's decision after the red-team, §12.1)

Rules that hold for every stretch item:
- **Entry gate.** No stretch work starts until **Gate B** passes. Gate B passes if, by **Sun 18 Oct 23:59 EAT**, `python scripts/verify_claims.py --base-url "$PUBLIC_API"` prints all PASS when run from an unauthenticated machine (`$PUBLIC_API` as defined in §6, the public path through the `web` proxy; never the run.app URL, which answers 403) and the latest `main` pipeline is green; the output is pasted into `docs/evidence/gate-b.txt` with its timestamp. If it is not green by then, the stretch tier is dropped for good, with no re-entry later in the week.
- **Priority.** Lean-core work always wins executor time. A stretch WP runs only while the lean core is not **red**. Red means: the `main` pipeline is failing, or a lean-core WP is not merged by the end of its scheduled day. The stretch executor checks this at the start of every stretch session and stops if it is red.
- **What Gate B does and does not mean.** Every required (T0/T1) endpoint is already live in prod and passes `verify_claims.py` before stretch work starts. The remaining lean-core work (WP-13 to WP-18) runs alongside the stretch lane and always has priority.
- **Drop, never squeeze.** Any stretch item that threatens Gate C or the **Wed 21 Oct 20:00 EAT** feature freeze is dropped. A stretch WP that is not merged and green in prod by **Wed 21 Oct 16:00 EAT** is dropped, and its branch stays unmerged.
- **No semantic change to required endpoints.** Every stretch WP's acceptance re-runs `verify_claims.py` against prod and the lean-core path and contract guards (§8 stretch preamble).
- **No stretch change can block a lean-core release.** Migrations added by stretch WPs never fail on a missing stretch role (§5 `0003`), CI creates every role a migration expects, and no lean-core job depends on a stretch job.
- **Independent.** Each item can be dropped alone. If behind, drop from the bottom: S4, then S3, then S2, then S1. All four drop before any lean-core item. If a lean-core item is cut for time, every stretch item has already been cut; the only exception is work that already shipped, which stays as shipped (§8 knock-on rule).

| Item | What it is | Brief line it strengthens | Gate / depends on | Cut order (1 = cut first) | ADR |
|---|---|---|---|---|---|
| S1 | Go 1.26 SSE gateway `clinic-realtime` (stdlib `net/http` + pgx v5) reading `appointment_events` with a commit-safe xid8 cursor; `GET /admin/metrics`; live recharts `/admin` dashboard; since §12.4 every stream needs a 60 s ticket from `POST /admin/stream-ticket`, which debits a monthly connected-seconds budget | Section 1 "components, key decisions, trade-offs" (a second runtime chosen for one job, with a written commit-order proof and an out-of-order-commit test) | Gate B; dashboard part (WP-S1d) also needs Gate C | 4 | [ADR-0009](../adr/0009-realtime-polling-now-sse-later.md), [ADR-0021](../adr/0021-go-realtime-gateway.md) |
| S2 | PWA app shell (Serwist), network-only for every API, stream and data route; dark/light/system theme with no flash | "A patient sees free slots ... books it" (UX only; weakest citation of the four) | Gate B + WP-16 shipped | 3 | [ADR-0010](../adr/0010-thin-nextjs-booking-ui.md) |
| S3 | Google OAuth (Auth.js v5) for `/admin` only; FastAPI verifies the Google ID token against Google's JWKS with an email allowlist; the gateway accepts a 60 s signed stream ticket (the ticket itself ships with S1 since §12.4; S3 puts Google auth in front of the ticket route) | "meaningful errors + correct HTTP status codes" (401/403 problem types); protects S1's admin surface | WP-S1d shipped | 2 | [ADR-0012](../adr/0012-identity-and-abuse-controls-deferred.md), [ADR-0022](../adr/0022-admin-auth-and-bot-protection.md) |
| S4 | Cloudflare Turnstile verified in the Next server route that submits UI bookings | "Patients book online" (abuse on the public write path, UI path only) | Gate B + WP-16 shipped | 1 | [ADR-0022](../adr/0022-admin-auth-and-bot-protection.md) |

**Answer to "tRPC, gRPC and TanStack: can they be used together?"** (full analysis in [ADR-0007](../adr/0007-api-style-rest-openapi.md))
- **TanStack Query** doesn't care about transport. It has a tRPC adapter (`@trpc/tanstack-react-query`) and a Connect/gRPC adapter (`@connectrpc/connect-query`), and it works just as well over a generated OpenAPI client.
- **tRPC** has no IDL. Its types are TypeScript inference over the server's `AppRouter`, so the server has to be TypeScript. A FastAPI or Go server cannot be a tRPC server. The only way in is a TypeScript BFF wrapping FastAPI, which adds a hop and a second contract to keep in sync.
- **gRPC.** Browsers cannot speak native gRPC. They need gRPC-Web or Connect, and Connect's Python implementation is pre-1.0.
- **So:** all three can be combined in a TypeScript-everywhere stack. With our Python backend, we use TanStack Query on the web side and reject tRPC and gRPC. The cross-language equivalent of tRPC's end-to-end types is pydantic → FastAPI OpenAPI 3.1 → `@hey-api/openapi-ts` (TS types + zod + TanStack Query hooks), guarded by a CI drift check ([ADR-0011](../adr/0011-openapi-codegen-contract.md)).

**Deliberate override of a default: region (amended by the $0 audit).** Cloud Run now runs in **us-east4 (N. Virginia)** with Neon in **aws-us-east-1**, behind the front door in the `web/` Vercel project in `iad1` (§12.3), not in africa-south1 and no longer in europe-west3. The reason is cost, not latency: Cloud Run's only free egress tier is North America to North America, europe-west3 is a Tier 2 compute region, and every byte Cloud Run sends straight to Kenya is billed from byte 0 from any region (verified from the Cloud Billing catalog, 2026-10-16; §13). We pay for it with a longer client hop (estimated +100-150 ms per request versus Frankfurt, unmeasured) and US data residency for the synthetic demo data. The Neon co-location argument below still holds; it now applies to us-east4 and aws-us-east-1. See [ADR-0014](../adr/0014-hosting-region-and-cost.md) and [ADR-0023](../adr/0023-zero-cost-edge-front-door.md). The original reasoning, kept for the record: Cloud Run runs in **europe-west3 (Frankfurt)**, not africa-south1, because Neon's nearest region is aws-eu-central-1. A booking makes 4-6 sequential DB round trips. Run from africa-south1, every one of them would cross Johannesburg to Frankfurt (estimated 150-200 ms each, **unmeasured**). Run from europe-west3, the client pays the long hop once per request. The cost is EU data residency, which would block production use with real Kenyan health data under the KDPA. The demo holds synthetic data only. See [ADR-0014](../adr/0014-hosting-region-and-cost.md).

---

# 1. Requirements traceability matrix

| # | Requirement (brief) | Component | Proving test / evidence | README section |
|---|---|---|---|---|
| R1 | System design: models, components, key decisions, trade-offs | README + `docs/adr/*` | `make docs-check` (links resolve; every ADR has the 7 headings) | §3, §4 |
| R2 | REST API in FastAPI/DRF/Go; any DB | `backend/app` (FastAPI 0.143.2), PG17 | `docker compose up -d --wait && curl -fsS localhost:8080/healthz` | §12 |
| R3 | POST validates working hours | `domain/booking_rules.py::validate_slot` | `tests/unit/test_booking_rules.py::test_outside_working_hours*`; `tests/integration/test_post_appointments.py::test_outside_hours_422` | §5 |
| R4 | POST validates not in past | same | `test_slot_in_past_422` (unit + integration) | §5 |
| R5 | POST validates not taken | `uq_appt_doctor_slot_booked` + `repositories/errors.py` | `test_double_book_409`; `tests/concurrency/test_race_same_slot.py` (1x201 / 24x409, lock-waiter proof); `test_naive_control_double_books` | §3.4 |
| R6 | GET availability: all free 30-min slots on a date | `services/availability.py` + `domain/slots.py` | `tests/unit/test_slots.py`; `tests/integration/test_availability.py` | §3.3 |
| R7 | Cancel with reason; slot bookable again | `services/booking.py::cancel` | `test_cancel_then_rebook_201` | §3.5 |
| R8 | Cancel errors if already cancelled | state guard | `test_cancel_twice_409_appointment_already_cancelled` | §5 |
| R9 | Reschedule: old slot freed, new slot validated like a fresh booking | `services/booking.py::reschedule` (in-place UPDATE under FOR UPDATE) | `test_reschedule_frees_old_slot`; `test_reschedule_runs_all_booking_rules` (parametrized over every slot 422); `tests/concurrency/test_race_reschedule.py`; swap-deadlock case | §3.5 |
| R10 | Reschedule errors if cancelled | state guard | `test_reschedule_cancelled_409` | §5 |
| R11 | Meaningful errors + correct status codes | `core/problems.py`, `domain/errors.py` | `tests/unit/test_error_catalogue.py`; Schemathesis `not_a_server_error`, `status_code_conformance`, `response_schema_conformance` | §5 |
| R12 | Sensible structure (not one file) | layered `backend/app/*` | Tree in README; `ruff` + `mypy --strict` pass | §6 |
| R13 | Basic test coverage of booking logic | `tests/{unit,integration,concurrency,contract,migrations}` | `pytest --cov=app --cov-fail-under=85` in CI | §7 |
| B1 | Bonus: upcoming appointments per patient, sorted | `api/routers/patients.py` | `test_upcoming_sorted_excludes_cancelled_and_past` | §5 |
| B2 | Bonus: no bookings within 1 hour | `BOOKING_MIN_LEAD_MINUTES=60` in validator + availability | `test_lead_59min_rejected`, `test_lead_60min_accepted`, `test_availability_hides_lead_window` | §8 |
| D1 | Deploy to any cloud, public URL | Cloud Run `clinic-api` ~~europe-west3~~ us-east4, public through the `web/` Vercel project's URL, REST under `/api` (ADR-0023, §12.3) | `scripts/verify_claims.py --base-url $URL` prints all PASS, run from a machine with no gcloud auth | §1 |
| D2 | CI runs tests on every PR | CircleCI workflow `pr` | README links a green PR pipeline (public repo) | §9 |
| D3 | Auto-deploy on merge to the designated branch | CircleCI workflow `release` on `main` | README links a green main pipeline, plus the WIF-deny and context-deny logs | §9 |
| D4 | README: URL, which branch, how, what the pipeline does | README | read | §1, §9 |
| A1-A4 | AI reflection | README §11 (AI usage summary) | written by the engineer only (ADR-0020) | §11 |
| G1 | "When ambiguous, decide and note in README" | §2 of this plan | n/a | §8 |
| S1 | **STRETCH.** Section 1 "components, trade-offs"; "must not be available to others" (staff view) | `services/realtime` (Go), migration `0003_event_cursor`, `app/api/routers/admin.py`, `web/src/app/admin` | `go test ./...`; `go test -tags=integration ./internal/feed/...` (`TestOutOfOrderCommits`, `TestNaiveIdCursorSkips`); `tests/integration/test_admin_metrics.py`; `scripts/verify_stream.py` after deploy | §4.4, §3.8 |
| S2 | **STRETCH.** "A patient sees free slots ... books it" (UX) | `web/src/app/{sw.ts, manifest.ts}`, next-themes provider | `web/tests/sw-config.test.ts` (data routes network-only); manifest `jq` check; Lighthouse accessibility ≥ 0.9 | §4.4 |
| S3 | **STRETCH.** "meaningful errors + correct HTTP status codes" (401/403) | `app/core/admin_auth.py`, `app/core/stream_ticket.py`, `web/src/auth.ts`, `services/realtime/internal/ticket` | `tests/integration/test_admin_auth.py`; `internal/ticket` tests; unauthenticated `curl` → 401 on `/admin/metrics` and `/stream` | §4.4, §10 |
| S4 | **STRETCH.** "Patients book online" (abuse, UI path) | `web/src/app/ui/appointments/route.ts`, `web/src/lib/turnstile.ts` | `web/tests/turnstile-route.test.ts`; Cloudflare test keys pass/fail run; direct `curl POST /appointments` still 201 (bypass stated) | §4.4, §10 |

---

# 2. Ambiguities & decisions

| # | Ambiguity | Decision | Why |
|---|---|---|---|
| AM-01 | What "past" means | `starts_at <= clock.now()` (UTC) → 422 `SLOT_IN_PAST`. A slot starting at this exact instant counts as past. | One unambiguous instant. The injected clock makes it testable. |
| AM-02 | Timezone | Single clinic, `clinics.timezone = 'Africa/Nairobi'` (UTC+03:00, no DST), stored as data. Instants are stored as UTC `timestamptz`. Input must be an RFC 3339 **string** with an offset: a naive string → 422 `TIMEZONE_REQUIRED`, a number → 422 `VALIDATION_ERROR`. Output is rendered in the clinic offset. Availability `date` is a clinic-local calendar date. | "On a day" only means something in a timezone. Because the zone is data, a second clinic needs no code change. |
| AM-03 | Patient identity / auth | v1 has **no authentication**. `patient_id` (UUID) goes in the body. The README states the resulting IDOR plainly and describes how auth layers in as a FastAPI dependency without changing the contract (ADR-0012). | The brief doesn't mention auth. Mandatory auth would 401 a reviewer who tries the brief's endpoints as written. Half-built optional auth is worse than an honest, documented gap. |
| AM-04 | Slot granularity / alignment | Slots are fixed at 30 minutes and aligned to the start of each working window. Windows start and end on :00 or :30 local time. A `starts_at` that is inside a window but off the grid, or has non-zero seconds or microseconds → 422 `SLOT_MISALIGNED`. The DB enforces `epoch % 1800 = 0`, which is valid only for whole or half-hour UTC offsets. | "Works in 30-minute slots." Variable durations are a review trigger (ADR-0003). |
| AM-05 | Cancel reason | Required, 3-500 characters after trimming whitespace, else 422 `VALIDATION_ERROR`. Never logged. | "With reason." A blank reason is meaningless. The reason is sensitive. |
| AM-06 | Cancel timing | Allowed inside the 60-minute lead window. After start (`starts_at <= now`) → 409 `APPOINTMENT_ALREADY_STARTED`. | The lead rule is about taking a slot, not giving one up. |
| AM-07 | Reschedule to the same slot | 200 no-op returning the unchanged appointment. No event is written. | Idempotent and harmless for client retries. |
| AM-08 | Does the 1-hour rule apply to reschedule? | Yes, to the new slot (422 `BOOKING_TOO_SOON`). | The brief says "validated like fresh booking". |
| AM-09 | Reschedule to a different doctor | Not allowed. A `doctor_id` in the body → 422 (`extra="forbid"`). Changing doctor means cancel + book. | Keeps reschedule a single-row, single-constraint operation. |
| AM-10 | Reschedule after start | 409 `APPOINTMENT_ALREADY_STARTED`. | Same reasoning as AM-06. |
| AM-11 | Availability for a past date, a non-working day or a fully booked day | 200 with `slots: []`. | It's a query, and an empty answer is truthful. |
| AM-12 | Horizon | A clinic-local date later than today + 90 → 422 `DATE_OUT_OF_RANGE` (booking and availability). | Bounds work. **The 90 is an invented business rule**, and the README says so. |
| AM-13 | Availability and the lead window | Availability hides slots with `starts_at < now + 60 min`. | A listed slot is bookable at the moment it is listed. |
| AM-14 | Patient double-booked across doctors | Forbidden by a DB constraint → 409 `PATIENT_DOUBLE_BOOKED`. | The brief is silent. A patient cannot be in two rooms at once. |
| AM-15 | Unknown entity in the body vs the path | An unknown body reference → 422 `UNKNOWN_DOCTOR` / `UNKNOWN_PATIENT`. An unknown path resource → 404. | The target resource exists, so the body is semantically invalid (RFC 9110). |
| AM-16 | Idempotency on POST (T2) | Optional `Idempotency-Key`. A replay with the same fingerprint while the appointment is still `booked` → 201 with the **current** representation plus `Idempotent-Replayed: true`. That state may differ from the first response if the appointment was rescheduled since. If the appointment is no longer booked → 409 `IDEMPOTENCY_KEY_CONSUMED`. Same key with a different payload → 422 `IDEMPOTENCY_KEY_REUSED`. | Retries on a flaky connection must not tell the real booker "slot taken". We don't store response bodies, so we document the representation semantics instead of claiming "original body". |
| AM-17 | Working hours change after a booking exists | Existing bookings stay valid. They are not re-validated or auto-cancelled. Recorded as debt. | No admin feature edits hours. The seed is the only writer. |
| AM-18 | Doctor leave / exceptions | Out of scope (debt with a review trigger). | Not in the brief. |
| AM-19 | Max active bookings per patient | **No cap.** | An earlier draft invented a cap of 3. It would lock reviewers out of shared demo patients and block the smoke test. The brief doesn't ask for it. Deferred with a trigger (ADR-0012). |
| AM-20 | Is cancel idempotent? | No. The second cancel → 409. | The brief says "error if already cancelled", which overrides the PATCH idempotency convention. |
| AM-21 | Upcoming list contents | `status='booked' AND starts_at > :now` (bind parameter from the clock), ordered by `starts_at ASC, id ASC`, `limit` default 50, max 100. | "Upcoming, sorted by date." An appointment in progress is not upcoming. |
| AM-22 | Data residency | Synthetic demo data stored in ~~Frankfurt~~ N. Virginia (aws-us-east-1; amended by the $0 audit). Real use would need a KDPA review and possibly an African-region database. | Stated as a production blocker. |
| AM-23 | Inactive doctors | `is_active=false` → 404 `DOCTOR_NOT_FOUND` on path routes (detail, availability), 422 `UNKNOWN_DOCTOR` in a booking body. Hidden from `GET /doctors`. Existing bookings with an inactive doctor can still be cancelled. Reschedule → 422 `UNKNOWN_DOCTOR`. | The column exists, so its semantics have to be defined. |
| AM-24 | Phone on `POST /patients` | Optional (E.164 when present). Seeded demo patients and smoke patients have no phone. | Avoids storing real-looking numbers in synthetic data. |
| AM-25 | Phone-exists oracle | `POST /patients` with an existing phone → 409 `PATIENT_PHONE_EXISTS`. This reveals whether a phone belongs to a patient. Recorded as debt: production would use OTP verification and an indistinguishable 202. | Honest about a KDPA-relevant leak instead of hiding it. |

---

# 3. Architecture

## 3.1 Components

| Component | Tech (resolved versions in §8 WP-00) | Responsibility | Tier |
|---|---|---|---|
| `clinic-api` | FastAPI 0.143.2, Python 3.12, SQLAlchemy 2.1.4 async + asyncpg 0.32.0, Pydantic 2.14.1, uvicorn 0.54.0 | System of record: all business rules, REST, problem catalogue | T0 |
| `clinic-migrate` | Same image, run as a Cloud Run Job (`alembic upgrade head && python -m app.scripts.seed`) | Ordered, expand-only schema changes before traffic moves | T0 |
| PostgreSQL 17 | Neon Free ~~aws-eu-central-1~~ aws-us-east-1, compute fixed at 0.25 CU (prod); `postgres:17-alpine` (local and CI) | Durable state and **the** double-booking guarantee | T0 |
| `web` (lean-core part, §12.3) | Next.js 16.4.2, React 19.3.1, `@vercel/oidc` (version resolved in WP-11 Part C) | Vercel Hobby project `clinic-web` in `iad1`. The front door: the route handler `/api/[...path]` (to `clinic-api`; `/api/stream` to `clinic-realtime`), forwarding to IAM-gated Cloud Run with an ID token minted via Vercel OIDC → WIF (ADR-0023); `/docs`, `/redoc` and `/openapi.json` as static routes built from `contracts/openapi.json` (~~proxied to `clinic-api` and CDN-cached~~, superseded by §12.4: they never reach Cloud Run); a minimal landing page linking to Swagger. The only public entry point | T0 |
| `web` booking pages | TanStack Query 5.104.3, zod 4.6.7, shadcn CLI 4.21.5, lucide, next-themes 0.4.6, Geist, on top of the lean-core project | Patient booking UI | T2 (cut 1st; cutting it leaves the T0 part) |
| CircleCI | Free plan, GitHub App trigger | Verify on PR; build, scan, migrate, deploy, smoke, promote on `main` | T0 |
| GCP | Artifact Registry, Cloud Run, Secret Manager, WIF, budget alert | Runtime and keyless deploy | T0 |
| GCP cost guards ($0 audit) | Cloud Run spend-cap budget ($3 gross), $1 alerts-only budget, daily egress alert policy, Artifact Registry cleanup policy, `cost-check` CI job | Keep every line inside its free tier (§13) | T0 |
| ~~`clinic-frontdoor`~~ (superseded, §12.3) | ~~a separate Vercel Hobby project with one route handler~~ | Merged into the `web` project above by the engineer's decision | n/a |
| `clinic-realtime` | Go 1.26, stdlib `net/http`, pgx v5 (exact versions resolved in WP-S1b and written to `docs/versions.md`); distroless static image | Read-only SSE fan-out of `appointment_events` to admin dashboards. Never writes, never decides availability | **STRETCH S1** |
| `web` `/admin` | recharts (version resolved in WP-S1d), Auth.js v5 Google provider (S3), Serwist (S2), Turnstile widget (S4) | Admin dashboard; PWA shell; admin sign-in; UI bot check | **STRETCH S1-S4** |

## 3.2 Context + container diagram

```mermaid
flowchart LR
  patient([Patient browser])
  reviewer([Reviewer: Swagger / curl / verify_claims.py])
  dev([Developer])

  subgraph Vercel[Vercel iad1: one project, web]
    web[web: Next.js 16<br/>landing page + T2 booking pages]
    fd[web route handler /api/*<br/>Vercel OIDC -> WIF -> ID token]
    docs[web static routes<br/>/docs, /redoc, /openapi.json<br/>built from contracts/openapi.json]
  end

  subgraph GCP_us_east4[GCP us-east4]
    api[clinic-api<br/>Cloud Run service, IAM-gated<br/>min 0 / max 3]
    job[clinic-migrate<br/>Cloud Run Job]
    sm[(Secret Manager<br/>db url app / db url migrate)]
    ar[(Artifact Registry)]
  end

  subgraph Neon_aws_us_east_1[Neon aws-us-east-1]
    db[(Postgres 17<br/>db clinic<br/>roles clinic_owner, clinic_app)]
  end

  gh[(GitHub repo, public)]
  ci[CircleCI]

  patient -->|HTTPS h2| web
  patient -->|HTTPS h2, same origin, REST under /api| fd
  reviewer -->|HTTPS /docs, static, no Cloud Run call| docs
  reviewer -->|Try it out: /api/*| fd
  fd -->|X-Serverless-Authorization: ID token, aud clinic-api| api
  api -->|asyncpg TLS, direct endpoint, role clinic_app| db
  job -->|alembic, role clinic_owner| db
  sm -->|--set-secrets app url| api
  sm -->|--set-secrets migrate url| job
  dev -->|PR| gh
  gh -->|GitHub App| ci
  ci -->|OIDC V2 -> WIF -> deployer SA| ar
  ci -->|jobs deploy/execute| job
  ci -->|run deploy --no-traffic --tag, update-traffic --to-tags| api
  ci -->|vercel deploy --prebuilt --prod, one project| web
  web -.-|same deployment| fd
  web -.-|same deployment| docs
```

Amended by the $0 audit and the engineer's hosting decision (§12.3): the patient and reviewer arrows now end at the front door, the proxy route handlers inside the `web` project, and `clinic-api` has no `allUsers` invoker, so a direct request to `*.run.app` is an IAM denial, which Cloud Run does not bill. CircleCI's pre-promotion smoke still calls the tag URL directly, with a `clinic-smoke` ID token, after the C19 gate confirms CircleCI's egress is in North America (WP-12). **Added by the hosting lock review (§12.4):** the documentation routes are static and never call Cloud Run, and a credential-free `smoke-public` job runs `verify_claims.py` against `$PUBLIC_API` after `ship-web`, so the public path itself is tested on every release.

## 3.3 Booking request flow

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as Router (api/routers/appointments.py)
  participant S as BookingService
  participant D as domain.booking_rules
  participant DB as Postgres
  C->>R: POST /appointments {doctor_id, patient_id, starts_at} [Idempotency-Key]
  R->>R: Pydantic (extra=forbid, str-only AwareDatetime) -> 422 VALIDATION_ERROR / TIMEZONE_REQUIRED
  R->>S: book(cmd, clock)
  S->>DB: BEGIN (READ COMMITTED)
  S->>DB: SELECT active doctor JOIN clinic; SELECT patient; SELECT working_hours(doctor, local weekday)
  S-->>C: 422 UNKNOWN_DOCTOR / UNKNOWN_PATIENT
  S->>DB: [T2] idempotency pre-SELECT (patient_id, key) -> 201 replay / 409 CONSUMED / 422 REUSED
  S->>D: validate_slot(starts_at, windows, tz, now, lead, horizon) (pure)
  D-->>S: 422 SLOT_IN_PAST / BOOKING_TOO_SOON / DATE_OUT_OF_RANGE / SLOT_MISALIGNED / OUTSIDE_WORKING_HOURS
  S->>DB: INSERT appointments (status='booked')
  S->>DB: INSERT appointment_events('booked')
  alt unique violation (SQLSTATE 23505)
    DB-->>S: IntegrityError(constraint_name)
    S->>DB: ROLLBACK
    S->>DB: [T2] re-check idempotency key first
    S-->>C: 409 SLOT_TAKEN / PATIENT_DOUBLE_BOOKED
  else deadlock / serialization (40P01 / 40001)
    S->>S: retry whole transaction once (jitter 20-80 ms), then 409 CONCURRENT_UPDATE
  else ok
    S->>DB: COMMIT
    S-->>C: 201 + Location: /appointments/{id}
  end
```

There is deliberately **no** "is the slot taken?" pre-SELECT. The constraint *is* the check: it is race-free and it is the single source of the 409.

## 3.4 Concurrency guarantee and how we prove it

- **Guarantee.** `CREATE UNIQUE INDEX uq_appt_doctor_slot_booked ON appointments (doctor_id, starts_at) WHERE status='booked'`, plus CHECKs that pin `ends_at = starts_at + 30 min` and the grid alignment. Under those CHECKs, equal `starts_at` means overlap (ADR-0003).
- **Proof that the harness races** (ADR-0018). Each step names the test that shows it.
  1. **Real run.** 25 requests are released by an `asyncio.Barrier` against one slot. The app runs with `DB_POOL_SIZE=30`, and a test-only hook inserts `pg_sleep(0.2)` after the INSERT and before COMMIT. A sampler on a separate connection polls `pg_locks WHERE locktype='transactionid' AND NOT granted` every 20 ms. We assert: exactly 1×201, 24×409 `SLOT_TAKEN`, 1 booked row, and **peak lock waiters ≥ 5**. The waiters are transactions blocked on the uniqueness check, which is direct evidence that they overlapped.
  2. **Naive control.** This runs in database `clinic_control`, which has the index dropped. A test-only `NaiveBookingService` does `SELECT ... WHERE status='booked'`, then `pg_sleep(0.1)`, then INSERT, released by the same barrier. We assert booked rows > 1. This shows that check-then-insert double-books under this harness and that the index is what saves us.
- **Proof of the other paths.** Reschedule swap (two appointments exchanging slots) → no 5xx, and the final state is either the original or the swap. Cancel-X-at-S running alongside reschedule-Y-into-S → never two booked rows at S, no 5xx.

## 3.5 Appointment state machine & reschedule atomicity

```mermaid
stateDiagram-v2
  [*] --> booked: POST /appointments (201)
  booked --> booked: PATCH reschedule (200, same id, new starts_at)
  booked --> cancelled: PATCH cancel (200)
  cancelled --> [*]
  note right of cancelled: cancel or reschedule again gives 409 APPOINTMENT_ALREADY_CANCELLED
```

- Cancel and reschedule each run in one transaction:
  1. `SELECT ... FOR UPDATE` on the appointment, then guard: 404 if missing, 409 if cancelled, 409 if already started.
  2. Reschedule only: same start → 200 no-op.
  3. Reschedule only: the same `validate_slot` as a booking.
  4. A single `UPDATE`, then `INSERT appointment_events`, then COMMIT.
- The reschedule UPDATE frees the old slot and claims the new one atomically. If the update fails with a constraint violation, the original booking is untouched. Details in ADR-0008.

## 3.6 Time model

- UTC `timestamptz` storage. The clinic IANA zone is data.
- A `Clock` dependency is injected everywhere. **Business SQL never calls `now()`**: the current instant is always a bind parameter from `clock.now()`. Column defaults like `created_at DEFAULT now()` are audit-only and never compared in business logic.
- Slot generation steps in UTC from window-start to window-end instants and dedupes.
- Availability reads booked rows in the UTC range `[local D 00:00, local D+1 00:00)`.
- Details in ADR-0005.

## 3.7 Freshness in the patient UI (polling; no push for patients)

- **How the UI stays fresh.** The availability query refetches every 15 s **only while the page is visible**, and also on window focus.
- **Idle stop.** Polling stops after 10 minutes without pointer or keyboard input, so an idle tab doesn't keep Cloud Run and Neon awake.
- **Lost race.** A 409 `SLOT_TAKEN` shows "That slot was just taken" and refetches.
- **Push for patients, deferred.** The patient booking UI keeps polling even if S1 ships. Availability correctness comes from the DB constraint, and the 409 path already handles a stale slot honestly. SSE is a UX enhancement for admins only (stretch S1, §3.9, ADR-0009).

## 3.8 Deployment pipeline

```mermaid
flowchart TB
  pr[PR push] --> wfpr[workflow 'pr'<br/>backend-quality, backend-test, backend-contract,<br/>secrets, sast, sca, image-build-scan, dast,<br/>web-quality, contract-drift]
  merge[Merge to main] --> wfrel[workflow 'release'<br/>same verify jobs]
  wfrel --> push[build-scan-push<br/>trivy image gate, push :sha, output digest]
  push --> ship[ship-api<br/>serial-group deploy-prod<br/>context gcp-deploy restricted to main]
  ship --> s1[OIDC V2 -> WIF<br/>condition: project-id AND vcs-ref == refs/heads/main]
  s1 --> s2[jobs deploy + execute clinic-migrate --wait<br/>advisory lock in alembic env]
  s2 --> s3[run deploy --no-traffic --tag sha-xxxxxxx by digest]
  s3 --> g19[C19 gate: CircleCI egress country is US<br/>else stop before any tag-URL call]
  g19 --> s4[verify_claims.py vs tag URL]
  s4 -->|FAIL| stop[stop: traffic untouched<br/>migrations already applied: expand-only, linted]
  s4 -->|PASS| s5{CIRCLE_SHA1 == origin/main HEAD?}
  s5 -->|no| skip[skip promote: a newer commit will ship]
  s5 -->|yes| s6[update-traffic --to-tags sha-xxxxxxx=100<br/>prune tags beyond last 3]
  s6 --> web[ship-web, lean core: vercel build/deploy --prebuilt --prod<br/>proxy route handler + static doc routes + landing page + any shipped UI pages]
  web --> sp[smoke-public, no context, no credentials<br/>verify_claims.py vs PUBLIC_API, servers check, /docs 200, run.app 403]
```

**Cost additions ($0 audit).** Both workflows run `cost-static` (no credentials: config lint for cost rules). `release` runs `ship-web` after `ship-api` (context `vercel-prod`; lean core since §12.3, because it deploys the proxy; the separate `ship-frontdoor` job of the first $0 draft is superseded and merged into it) and `cost-check` after `ship-api` (context `gcp-deploy`, read-only gcloud), which fails the release if any Cloud Run service lacks max-instances, min-instances is above 0 (revision or service level), the scaling mode is not `automatic` (manual scaling bills its instances continuously; §12.4), CPU is always allocated, an `allUsers` invoker exists or the invoker IAM check is disabled, Artifact Registry holds more than 2 versions per package or more than 400 MB, or more than 6 secret versions are active (WP-12a). The tag prune keeps the last 2, not 3, to match Artifact Registry. **Added by the hosting lock review (§12.4):** `smoke-public` runs after `ship-web` with no context and no credentials and is never cut; it fails the release (red pipeline, rollback runbook) if the public path breaks, for example an expired OIDC trust, a WIF condition mismatch, a header bug or a route that shadows `/api/*`. Its Cloud Run egress goes to Vercel `iad1` (North America to North America, inside the free tier).

**Stretch addition (S1).** The release workflow gains `build-scan-push-realtime → ship-realtime` as a separate branch that depends on `ship-api` (migrations applied there) and runs under its own serial group `deploy-prod-realtime`. `ship-web` still depends only on `ship-api`, so a realtime failure never blocks the API or the web release (ADR-0016).

## 3.9 STRETCH S1: realtime admin feed

Built only after Gate B. Nothing here changes the booking path: FastAPI already writes `appointment_events` in the same transaction as the state change (the 0001 DDL and "Transaction semantics" in §5). Its columns carry everything the stream needs except a commit-safe cursor, which the expand-only migration `0003_event_cursor` adds. The same-transaction property is a design statement until WP-S1a's `test_event_cursor_column.py` asserts it against real Postgres (event and appointment row written by the same transaction, and a forced failure after the event insert leaves neither row).

```mermaid
flowchart LR
  admin([Admin browser<br/>web /admin])
  patient([Patient browser])

  subgraph Vercel[Vercel iad1: one project, web]
    web[web: Next.js 16<br/>/admin dashboard, recharts]
    fd[web route handler api catch-all<br/>path-preserving proxy, maxDuration 300 s]
  end

  subgraph GCP_us_east4[GCP us-east4]
    api[clinic-api<br/>FastAPI, system of record]
    rt[clinic-realtime<br/>Go net/http SSE gateway<br/>min 0 / max 2, 0.25 vCPU, concurrency 1, timeout 300 s]
  end

  subgraph Neon_aws_us_east_1[Neon aws-us-east-1]
    db[(Postgres 17<br/>appointment_events + txid xid8<br/>role clinic_realtime: column SELECT only)]
  end

  patient -->|REST, polling 15 s, via front door| fd
  admin -->|1. GET /admin/metrics: aggregates + cursor| fd
  admin -->|2. POST /api/admin/stream-ticket, then EventSource /api/stream?cursor=&ticket=| fd
  fd -->|ID token, aud clinic-api| api
  fd -->|/api/stream to /stream, ID token, aud clinic-realtime| rt
  api -->|same txn: INSERT appointments + appointment_events| db
  rt -->|poll ~1 s, only while >= 1 client:<br/>txid < pg_snapshot_xmin, ORDER BY txid, id| db
```

```mermaid
sequenceDiagram
  autonumber
  participant B as Admin browser
  participant A as clinic-api
  participant G as clinic-realtime
  participant DB as Postgres
  B->>A: GET /admin/metrics?days=7
  A->>DB: BEGIN REPEATABLE READ READ ONLY; H := pg_snapshot_xmin(pg_current_snapshot()); aggregates WHERE txid < H
  A-->>B: 200 {hourly[], utilization[], cursor:"H.0"}
  B->>G: GET /stream?cursor=H.0
  G->>G: subscribe to the instance broadcast, then catch-up read from cursor (dedupe by cursor)
  loop every ~1 s while subscribers > 0
    G->>DB: SELECT ... WHERE (txid,id) > (c_txid,c_id) AND txid < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY txid, id LIMIT 500
    G-->>B: id: <txid>.<id> / event: appointment.booked / data: {schema_version:1, ...}
  end
  G-->>B: ": hb" comment every 15 s
  G-->>B: event: reconnect at ~290 s, then close
  B->>G: reconnect with Last-Event-ID (or ?cursor= after S3, with a fresh ticket)
```

**Why the cursor is commit-safe.** `id` (identity) and `occurred_at` are assigned when a row is written, not when its transaction commits, so a reader that advances on `id > last_id` can skip a row whose transaction commits after a later one (the naive-cursor control in WP-S1b demonstrates the skip). Each event row instead stores `txid xid8 DEFAULT pg_current_xact_id()`, the writing transaction's 64-bit id. Every transaction whose xid is below the current snapshot's `xmin` has finished, so once `txid < pg_snapshot_xmin(pg_current_snapshot())` a row's visibility can no longer change. The gateway reads only those rows, ordered by `(txid, id)`, and the SSE `id:` is that pair. Resume from `Last-Event-ID` is therefore exact: no skip, no duplicate. The cost is latency: an event waits until every older open write transaction finishes (normally milliseconds; risk K23).

**Verified locally (2026-10-16, throwaway `postgres:17` container, PostgreSQL 17.11).** With T1 open after inserting a row and T2 inserting and committing a later row, a naive `id`-ordered read showed only T2's row (identity 7 visible, 6 not yet), so a reader advancing on `id > last_id` would skip T1's row for good. The horizon query returned no rows while T1 was open and exactly [T1, T2] after T1 committed. Same session: `pg_current_xact_id` and `pg_current_snapshot` have `provolatile = 's'`, and `ALTER TABLE ... ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id()` left `pg_relation_filenode` unchanged with `atthasmissing = t` (fast default, no table rewrite); the row comparison `(txid, id) > ($1::text::xid8, $2::bigint)` and a btree on `(txid, id)` both work; `max_prepared_transactions` is `0` in the stock image. None of this has been run on Neon yet; WP-S1a's tier E step does that.

**Horizon stalls and lag.** `xmin` is cluster-wide, so any long write transaction holds the stream back: a `clinic_owner` session left in `BEGIN`, another database on the same compute, or a prepared (2PC) transaction. Mitigations: `idle_in_transaction_session_timeout` on every login role (§5 roles), `max_prepared_transactions = 0` confirmed on Neon in WP-S1a, and a per-tick lag signal computed without assigning an xid: `pg_snapshot_xmax(pg_current_snapshot()) - pg_snapshot_xmin(pg_current_snapshot())` (xids in flight) plus the seconds since the horizon last advanced while that difference is non-zero. The gateway logs a WARN when the stall exceeds 10 s (K23).

**Why not LISTEN/NOTIFY.** It does not remove the need for the cursor and adds costs we do not want:
- NOTIFY is lossy for a client that is not connected, so reconnect catch-up still needs the commit-safe cursor; LISTEN would only replace a 1 s tick.
- It needs a trigger or a `pg_notify` call inside the booking transaction, and the stretch rules forbid touching the booking path.
- NOTIFY takes a global lock at commit, which serializes committing writers, the booking transactions included.
- LISTEN needs a dedicated session held open even when no client is connected, and Neon's pooled endpoint does not support it.

Polling instead runs only while a client is connected. The gateway opens its pgx pool when the first subscriber arrives and closes it (`pool.Close()`) when the subscriber count returns to 0, with `MaxConnIdleTime` 60 s in between, so an idle instance holds no DB connection at all. Neon does not suspend compute while connections are active; whether it then suspends within its idle window once the gateway has closed its pool is **unverified** until WP-S1c measures it (K24).

**Fan-out.** Each instance polls independently. At max 2 instances and 1 poll/s that is at most 2 cursor queries per second, which is correct and cheap here. At 10x-100x instances the per-instance poll load and connections grow linearly; the review trigger in ADR-0021 moves fan-out to one relay (a single poller publishing to Upstash Redis pub/sub or Pub/Sub).

**Stream cost caps ($0 audit; numbers in §13).** Under request-based billing an open stream bills its instance for every second it is open, so the caps are set from the CPU allowance, not from load: `--cpu 0.25 --concurrency 1 --max-instances 2` (at most 2 streams at once, 900 vCPU-s per connected hour), `STREAM_MAX_SECONDS=290` (inside Hobby's 300 s function maximum), the dashboard closes the stream on a hidden tab and after 10 minutes without input and only reopens on a click, and the Cloud Run spend cap stops everything before gross compute reaches the free discount. ~~A dashboard held live 8 h a day for 7 days uses about 50,400 vCPU-s, 28% of the month's allowance.~~ **Superseded by the hosting lock review (§12.4):** that was not the adversarial bound. The 10-minute idle close is client-side, and a script can hold `/api/stream` open around the clock: at 2 streams × 720 h a month × 900 vCPU-s an hour that is 1,296,000 vCPU-s, about 7 times the allowance, bounded before this change only by the $3 gross spend cap, whose enforcement "isn't instant" and which may not count network SKUs (docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps, read 2026-10-16). The server-side guard is now a **monthly connected-seconds budget enforced by `clinic-api` at ticket issue**: every stream needs a ticket (`STREAM_AUTH_REQUIRED=true` in Cloud Run from S1 on, not from S3), each ticket debits `STREAM_TICKET_DEBIT_SECONDS`=700 from the clinic-local month's row in `stream_budget` (a ticket is reusable for 60 s, at most 2 streams are open at once and each lasts at most 290 s, so one ticket can never buy more than 2 × (60 + 290) = 700 connected seconds; deduced), and once `STREAM_BUDGET_SECONDS`=345,600 (96 h) is reached the route returns 503 `STREAM_BUDGET_EXHAUSTED` and the dashboard falls back to click-to-refresh `/admin/metrics`. However many clients try, realtime compute is then at most 345,600 s × 0.25 = 86,400 vCPU-s a month (§13.4 W1). The gateway stays read-only: the budget row is written by `clinic-api`. If heartbeats do not flush through the front door (WP-S1c), S1 is cut and the dashboard polls `/admin/metrics`.

**Exposure.** Stream payloads are aggregate and non-PII: `doctor_id`, slot start, event type, local dates, occurred_at. No `appointment_id` (it is a capability handle while TD5 stands), no patient ids, names, phones or reasons. That makes `/stream` and `/admin/metrics` safe to expose publicly until S3 gates them. Exposure is not the same as cost: since §12.4 the stream is public but metered by the ticket budget.

## 3.10 STRETCH S3/S4: admin auth flow and UI bot check

```mermaid
sequenceDiagram
  autonumber
  participant B as Admin browser
  participant N as Next.js (Vercel) server routes
  participant GG as Google OAuth / JWKS
  participant A as clinic-api
  participant G as clinic-realtime
  B->>N: GET /admin (no session)
  N-->>B: redirect to Auth.js Google sign-in
  B->>GG: consent
  GG-->>N: code -> tokens (id_token kept server-side in the Auth.js encrypted JWT cookie)
  B->>N: GET /admin/api/metrics
  N->>A: GET /admin/metrics, Authorization: Bearer <Google id_token>
  A->>GG: JWKS (cached, single-flight, cooldown)
  A->>A: RS256 only; iss accounts.google.com; aud == GOOGLE_OAUTH_CLIENT_ID; exp; email_verified; email in ADMIN_EMAILS
  A-->>N: 200 / 401 ADMIN_AUTH_REQUIRED / 403 ADMIN_FORBIDDEN
  B->>N: POST /admin/api/stream-ticket
  N->>A: POST /admin/stream-ticket (Bearer id_token)
  A-->>N: {ticket (HMAC-SHA256, exp 60 s, aud clinic-realtime), expires_at}
  N-->>B: ticket
  B->>G: EventSource /stream?cursor=...&ticket=...
  G->>G: hmac.Equal + exp + aud check at connect only
  G-->>B: 200 text/event-stream, or 401 ADMIN_AUTH_REQUIRED
```

- **Superseded by ADR-0023 and §12.4 (kept for the record):** the stream now passes through the Next proxy route `/api/stream`. The ticket is still needed, because EventSource cannot set headers and the gateway must not trust the browser, and since §12.4 it also carries the monthly stream budget. The original rationale follows, struck where it no longer holds.
- ~~**Why a ticket, not a Next proxy.**~~ EventSource cannot set headers. ~~A same-origin Next route proxying the stream would hold a Vercel function open for the whole stream (billed, duration-capped on Hobby) and put a second hop in the long-lived path.~~ (Accepted since ADR-0023: Hobby does not bill, and 290 s fits the 300 s maximum.) A 60 s signed ticket issued by FastAPI ~~keeps the stream direct to Cloud Run,~~ keeps the Go service on the standard library (HMAC only, no JWT/JWKS code in Go) and keeps one Google-token verifier in the codebase. Trade-off: the ticket sits in a URL and therefore in Cloud Run request logs; it is short-lived, single-purpose, carries no email, and only grants the non-PII stream (ADR-0022, TD21). The ticket is **reusable within its 60 s TTL** (there is no `jti` and no replay set); a copied ticket opens streams for at most a minute, still bounded by the per-IP cap.
- **`aud` is not the trust boundary.** Anyone can mint a Google service-account ID token with any audience, so the `aud` check only rejects tokens meant for other clients. The real gate is `email_verified` plus the `ADMIN_EMAILS` allowlist.
- **Session and token lifetime agree.** `admin/layout.tsx` compares the stored `id_token` expiry with now minus 60 s and forces re-auth when it has passed, so the web never shows a signed-in dashboard that the API will reject. `stream.ts` treats a 401 `ADMIN_AUTH_REQUIRED` from the ticket route as "sign in again" and redirects, rather than backing off forever.
- **Patient endpoints stay unauthenticated.** IDOR (TD5) and the phone oracle (TD14) are unchanged.
- **S4 bot check.** The UI booking dialog gets a Turnstile token and posts to the same-origin route `POST /ui/appointments` (it was `/api/appointments`; `/api/*` belongs to the proxy since §12.3). The route calls Cloudflare `siteverify` server-side (single-use token, so replays fail) and checks that the returned `hostname` is the web domain and `action` is `book`, then forwards the original body and `Idempotency-Key` to `POST /appointments` on the API and returns the API's status and body unchanged. **Direct API calls (Swagger, curl, scripts) are not bot-protected.** That is deliberate so reviewers keep working, and the real fix is API-side enforcement once API auth exists (ADR-0022, TD22).
- **Region and contract for the server routes.** Vercel functions default to `iad1`, which would put two transatlantic hops (siteverify, then europe-west3) on every UI booking. The S4 route and the S3 `/admin/api/*` routes set `export const preferredRegion = "fra1"`. **Amended by the $0 audit:** the API moved to us-east4, so `iad1` is now the near region; `fra1` is dropped, `web/vercel.json` sets `"regions": ["iad1"]` for the whole project (Hobby allows a single function region, and a per-route region that differs could fail the deploy), and the routes call `API_BASE_URL` = the front-door URL. **Amended again (§12.3):** the routes live in the same project as the proxy, so they call the proxy's server-side helper `web/src/lib/proxy/call-api.ts` (same ID token, same header rules) in-process instead of their own public URL, and `API_BASE_URL` is no longer needed. The S4 route types the body it forwards with the generated zod schema for the `POST /appointments` request, so the codegen drift gate still covers the patient UI's main write even though the dialog no longer calls the generated client directly.

---

# 4. ADRs

All architecture decisions are recorded MADR-style in [`docs/adr/`](../adr/README.md), ADR-0001 to ADR-0023 (ADR-0021 and ADR-0022 cover the gated stretch tier; ADR-0023, added by the $0 audit, covers the zero-cost edge and records the engineer's hosting decision, §12.3). Each one has the same seven sections: Status, Context, Considered options, Decision, Consequences, Assessment line, Review trigger. The index table maps each ADR to the brief line it serves.

---

# 5. Data model

**Migration rules.**
- Migrations are hand-written: `0001_initial`, and `0002_idempotency` from WP-14 if it ships. **STRETCH:** `0003_event_cursor` from WP-S1a if S1 ships, and `0004_stream_budget` from WP-S1c (§12.4: `CREATE TABLE stream_budget (month date PRIMARY KEY, debited_seconds bigint NOT NULL DEFAULT 0 CHECK (debited_seconds >= 0))`, `GRANT SELECT, INSERT, UPDATE ON stream_budget TO clinic_app`; expand-only, downgrade drops the table with `# contract-ok: downgrade only`). Its `down_revision` is whatever head exists at the time, so a gap in the numbers (if WP-14 was cut) is harmless.
- **One head, always.** Parallel branches must not both build on the same parent. WP-S1a rebases onto `main` after WP-14 merges (or after WP-14 is formally cut) and sets `down_revision` to the actual head at that moment. `cd backend && uv run alembic heads | wc -l` → `1` is an acceptance step of every migration-carrying WP from WP-S1a on, and WP-S1a adds the same check to `backend-quality` (it reads only the scripts, so it needs no database).
- All are **expand-only**, enforced by `migration-lint` (ADR-0015).
- Partial indexes, CHECKs and grants go through `op.execute()` raw SQL. Alembic autogenerate is not used.
- UUIDs are generated in the app (uuid4), with `gen_random_uuid()` as the DB default too.
- Status columns are text + CHECK, never PG enums.

**Roles** (ADR-0015).
- `clinic_owner` owns all objects and runs migrations.
- `clinic_app` is the runtime role: SELECT/INSERT/UPDATE only, no DDL, no DELETE.
- `clinic_app` must exist before `0001` runs. Compose and CI create it, and the Neon runbook creates it in prod.
- **STRETCH S1:** `clinic_realtime` is the gateway's read-only role: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, column-level `SELECT` on `appointment_events` (every column except `appointment_id`) and nothing else. No default privileges, so later tables are never readable by it. It has its own secret and service account (ADR-0015). `backend/docker/initdb/02-realtime-role.sql` creates it locally and in CI (both `backend-test` and the `dast` compose stack). In prod the engineer creates it on Neon **before** WP-S1a merges (WP-S1a precondition). Unlike `0001`, migration `0003` does **not** fail if the role is missing: it adds the column and index, skips the grants with a `NOTICE`, and the runbook's role-creation step applies the same grants idempotently. A stretch role can therefore never block a lean-core release (risk K35).
- **STRETCH S1:** the runbook also sets `idle_in_transaction_session_timeout` on every login role, so an abandoned transaction cannot hold the stream horizon back indefinitely (K23): `clinic_app` `'30s'`, `clinic_realtime` `'30s'`, `clinic_owner` `'5min'` (manual sessions; migrations do not idle inside a transaction, so this does not affect them).

```sql
-- 0001_initial
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    RAISE EXCEPTION 'role clinic_app missing: see docs/runbooks/neon.md';
  END IF;
END $$;

CREATE TABLE clinics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  timezone    text NOT NULL,                    -- IANA; validated with zoneinfo in seed/app
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  full_name   text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  specialty   text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_doctors_clinic_active ON doctors (clinic_id) WHERE is_active;

CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO 1=Mon..7=Sun
  start_time  time NOT NULL,                                       -- clinic-local wall time
  end_time    time NOT NULL,
  CONSTRAINT ck_wh_order CHECK (start_time < end_time),            -- no midnight crossing
  CONSTRAINT ck_wh_align CHECK (
        extract(minute FROM start_time) IN (0,30) AND extract(second FROM start_time) = 0
    AND extract(minute FROM end_time)   IN (0,30) AND extract(second FROM end_time)   = 0),
  CONSTRAINT uq_wh_doctor_day_start UNIQUE (doctor_id, weekday, start_time)
);
-- DEBT TD2: overlapping windows per (doctor, weekday) are prevented only by seed validation.

CREATE TABLE patients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
  phone       text NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),    -- E.164, optional
  email       text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_patients_phone UNIQUE (phone)                      -- multiple NULLs allowed
);

CREATE TABLE appointments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id            uuid NOT NULL REFERENCES doctors(id),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'booked',
  cancellation_reason  text NULL,
  cancelled_at         timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_appt_status    CHECK (status IN ('booked','cancelled')),
  CONSTRAINT ck_appt_duration  CHECK (ends_at = starts_at + interval '30 minutes'),
  CONSTRAINT ck_appt_alignment CHECK ((extract(epoch FROM starts_at))::numeric % 1800 = 0),
      -- valid only for whole/half-hour UTC offsets (Africa/Nairobi +03:00)
  CONSTRAINT ck_appt_cancel_consistency CHECK (
       (status = 'booked'    AND cancelled_at IS NULL     AND cancellation_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL
        AND length(btrim(cancellation_reason)) BETWEEN 3 AND 500))
);
-- THE double-booking guarantee:
CREATE UNIQUE INDEX uq_appt_doctor_slot_booked  ON appointments (doctor_id,  starts_at) WHERE status = 'booked';
-- Patient in one place at a time; also serves GET /patients/{id}/appointments (upcoming, sorted):
CREATE UNIQUE INDEX uq_appt_patient_slot_booked ON appointments (patient_id, starts_at) WHERE status = 'booked';

CREATE TABLE appointment_events (                  -- audit trail; also the stretch S1 SSE source (ADR-0009, ADR-0021)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  appointment_id  uuid NOT NULL REFERENCES appointments(id),
  doctor_id       uuid NOT NULL REFERENCES doctors(id),
  event_type      text NOT NULL CHECK (event_type IN ('booked','cancelled','rescheduled')),
  from_starts_at  timestamptz NULL,                -- cancelled, rescheduled
  to_starts_at    timestamptz NULL,                -- booked, rescheduled
  local_date      date NOT NULL,                   -- clinic-local date of to_starts_at (from_ for cancel)
  from_local_date date NULL,                       -- reschedule across days
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_events_doctor_id ON appointment_events (doctor_id, id);
-- No reason or PII here; the reason lives on appointments.

GRANT USAGE ON SCHEMA public TO clinic_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO clinic_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO clinic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO clinic_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO clinic_app;

-- 0002_idempotency (WP-14, T2)
ALTER TABLE appointments ADD COLUMN idempotency_key text NULL
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[\x21-\x7E]{1,255}$');
ALTER TABLE appointments ADD COLUMN request_fingerprint char(64) NULL;
ALTER TABLE appointments ADD CONSTRAINT ck_appt_idem_pair
  CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL));
CREATE UNIQUE INDEX uq_appt_patient_idem ON appointments (patient_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 0003_event_cursor (WP-S1a, STRETCH S1). Expand-only: one added column, one index, grants.
SET LOCAL lock_timeout = '5s';   -- the ALTER takes ACCESS EXCLUSIVE; never queue behind a booking for long
ALTER TABLE appointment_events
  ADD COLUMN txid xid8 NOT NULL DEFAULT pg_current_xact_id();
  -- The writing transaction's 64-bit id (xid8: epoch-extended, no wraparound, btree-ordered).
  -- FastAPI never sets it; the default fires inside the booking/cancel/reschedule transaction.
  -- pg_current_xact_id() is STABLE (provolatile 's'), so PG 11+ uses the fast-default path:
  -- no table rewrite; existing rows read the value computed once at ALTER time, the migration's
  -- own xid, which is below every later id, so they sort before any new event (verified locally
  -- on PG 17.11, 2026-10-16: filenode unchanged, atthasmissing = t). The ALTER still takes an
  -- ACCESS EXCLUSIVE lock for its (short) duration, hence the lock_timeout above.
CREATE INDEX ix_events_txid_id ON appointment_events (txid, id);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
    GRANT USAGE ON SCHEMA public TO clinic_realtime;
    GRANT SELECT (id, txid, doctor_id, event_type, from_starts_at, to_starts_at,
                  local_date, from_local_date, occurred_at)
      ON appointment_events TO clinic_realtime;       -- appointment_id deliberately excluded
  ELSE
    -- Never fail a lean-core release on a stretch role. The runbook's role-creation step
    -- applies the same two GRANTs idempotently (docs/runbooks/neon.md).
    RAISE NOTICE 'role clinic_realtime missing: grants skipped; see docs/runbooks/neon.md';
  END IF;
END $$;

-- 0003 downgrade (needed by the migrations round-trip test):
-- DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_realtime') THEN
--   REVOKE ALL ON appointment_events FROM clinic_realtime;
--   REVOKE USAGE ON SCHEMA public FROM clinic_realtime;
-- END IF; END $$;
-- DROP INDEX ix_events_txid_id;
-- ALTER TABLE appointment_events DROP COLUMN txid   # contract-ok: downgrade only

-- The gateway's only query (horizon and rows from the same statement snapshot):
-- SELECT id, txid::text, doctor_id, event_type, from_starts_at, to_starts_at,
--        local_date, from_local_date, occurred_at
-- FROM appointment_events
-- WHERE (txid, id) > ($1::text::xid8, $2::bigint)
--   AND txid < pg_snapshot_xmin(pg_current_snapshot())
-- ORDER BY txid, id
-- LIMIT 500;
-- xid8 crosses the wire as text: whether pgx v5 has a native xid8 codec is unverified, so we
-- do not depend on it (WP-S1b pins this with a test).
```

**Error mapping** (`repositories/errors.py`).
- Map by SQLSTATE first, then by constraint name.
- Read both from the asyncpg exception chained under the SQLAlchemy `DBAPIError`. The expected path is `exc.orig.__cause__` with `.sqlstate` and `.constraint_name`, which is **unverified**. WP-07's first test, `test_constraint_name_path`, pins it before anything is built on it.

| SQLSTATE / constraint / exception | Result |
|---|---|
| 23505 `uq_appt_doctor_slot_booked` | 409 `SLOT_TAKEN` |
| 23505 `uq_appt_patient_slot_booked` | 409 `PATIENT_DOUBLE_BOOKED` |
| 23505 `uq_appt_patient_idem` | idempotency replay path (201 / 409 / 422) |
| 23505 `uq_patients_phone` | 409 `PATIENT_PHONE_EXISTS` |
| 40P01 deadlock, 40001 serialization | retry the whole service transaction once (jitter 20-80 ms), then 409 `CONCURRENT_UPDATE` |
| `sqlalchemy.exc.TimeoutError` (pool), `OperationalError`/`InterfaceError` on connect, `OSError`, `ConnectionRefusedError`, `socket.gaierror` | 503 `DB_UNAVAILABLE` + `Retry-After: 2` |
| 23514 (`ck_*`) or anything unknown | re-raise → 500 `INTERNAL_ERROR`, logged at error level **without bound parameters** (`hide_parameters=True`) |

**Transaction semantics** (all READ COMMITTED, `async with session.begin()` inside services, never in routers):
- **book:** SELECT active doctor JOIN clinic; SELECT patient; SELECT working_hours(doctor, local weekday); [idempotency pre-SELECT]; validate; INSERT appointment; INSERT event; COMMIT.
- **cancel:** SELECT FOR UPDATE; guards; UPDATE status/cancelled_at/cancellation_reason/updated_at (all `= :now`); INSERT event; COMMIT.
- **reschedule:** SELECT FOR UPDATE; guards; same-start no-op; validate (new); UPDATE starts_at/ends_at/updated_at; INSERT event(from, to); COMMIT.
- **STRETCH S1, admin metrics (read only):** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; first statement `SELECT pg_snapshot_xmin(pg_current_snapshot())` → H (in REPEATABLE READ every later statement shares that snapshot); hourly aggregates over `appointment_events WHERE txid < H`; per-doctor booked counts for today in one grouped query plus one `working_hours` read (no N+1); COMMIT. The response carries `cursor = "H.0"`, so stream increments start exactly where the aggregates stop. None of the three mutation transactions above change.

**Seed** (`app/scripts/seed.py`).
- Uses deterministic ids `uuid5(NAMESPACE, "<kind>:<key>")` with `NAMESPACE = uuid.UUID("6f1c2a52-6a0e-4c7a-9a3e-2b6f2d1c0a11")`.
- **Writes are `INSERT ... ON CONFLICT (id) DO UPDATE` only. No DELETE, ever.** The seed runs against live prod on every deploy.
- It validates that windows don't overlap before writing.

| Doctor | Specialty | Hours (Africa/Nairobi) | working_hours rows |
|---|---|---|---|
| Dr. Achieng Otieno | General Practice | Mon-Fri 08:00-12:00 and 13:00-17:00 (16 slots/day) | 10 |
| Dr. Brian Kamau | Paediatrics | Mon-Fri 09:00-17:00 (16 slots/day) | 5 |
| Dr. Chebet Rotich | Dermatology | Mon, Wed, Fri 08:00-14:00 (12 slots/day) | 3 |
| Dr. David Mwangi | Obstetrics & Gynaecology | Tue, Thu 10:00-18:00; Sat 09:00-13:00 | 3 |
| Dr. Esther Njeri | Dentistry | Mon-Sat 07:00-11:00 (8 slots/day) | 6 |
| **Total** | | | **27 (fixed expected value)** |

- Clinic: "Mvule Family Clinic" (fictional), `Africa/Nairobi`.
- Demo patients (no phone): Amina Hassan, Brian Otieno, Wanjiru Kariuki.
- The expected count of 27 comes from this table. If the database shows anything else, **the seed is wrong, not the number**.

---

# 6. API contract

**Global**
- Base URL: ~~`https://clinic-api-<hash>.europe-west3.run.app`~~ ~~`https://<clinic-frontdoor>.vercel.app`~~ (superseded, §12.3) `https://<clinic-web>.vercel.app/api` (recorded after the first deploy; amended by the $0 audit and by the engineer's hosting decision). Every path in the tables below is relative to it and unchanged: `/api/doctors` reaches `GET /doctors`. Swagger, ReDoc and the spec are served at the web origin root: `https://<clinic-web>.vercel.app/docs`, `/redoc` and `/openapi.json` (row 14). The Cloud Run URL `https://clinic-api-<hash>.us-east4.run.app` is IAM-gated and answers 403 to anyone without an invoker token (ADR-0023). `PUBLIC_BASE_URL` is `https://<clinic-web>.vercel.app/api`, so problem `type` URIs resolve through the proxy.
- **URL placeholders (hosting lock review, §12.4), used verbatim everywhere in this plan:** `WEB=https://<clinic-web>.vercel.app` (the web origin: landing page, `/docs`, `/redoc`, `/openapi.json`) and `PUBLIC_API=https://<clinic-web>.vercel.app/api` (the REST base). Commands write `$WEB` and `$PUBLIC_API`; `<prod>`, `<prod api>`, `<web>` and `<api>` in older text mean these two and nothing else. The run.app URL is written in full (`https://clinic-api-<hash>.us-east4.run.app`) and is used only by CI with an invoker token, and by the 403 checks.
- **`Location` at the public origin (§12.4).** The API emits a root-relative `Location` (`/patients/{id}`, `/appointments/{id}`), which is correct at the run.app origin and locally. The proxy rewrites any upstream `Location` that starts with `/` to `/api` + value, so a client at the public origin resolves it to `$PUBLIC_API/appointments/{id}`. The contract and the local compose path are unchanged.
- JSON. Request bodies use `extra="forbid"`. Instants are RFC 3339 strings with an offset; output is at `+03:00`.
- Every response carries `X-Request-ID` and `Server-Timing: db;dur=X, app;dur=Y`. Availability, appointment and patient responses add `Cache-Control: no-store`.
- CORS: `allow_origins=[WEB_ORIGIN, "http://localhost:3000"]`; methods GET/POST/PATCH/OPTIONS; headers Content-Type, Idempotency-Key, X-Request-ID; exposed Location, X-Request-ID, Retry-After, Idempotent-Replayed; no credentials. Behind the proxy the UI and Swagger are same-origin with the API (§12.3), so in prod browsers send no CORS preflight; the list matters for local development.
- Problem `type` is `{PUBLIC_BASE_URL}/problems/<slug>`, where the slug is the code in kebab-case (`SLOT_TAKEN` → `slot-taken`). In the schema, `code` is an **enum** of all catalogue codes, which gives the generated TS client an exhaustive union.
- Every route declares its problem responses in `responses=`, because Schemathesis needs them.
- Rows marked (T2) exist only once WP-14 ships.

**Status rule (copied verbatim into the README):** 404 means the resource in the **path** doesn't exist. 422 means the request is well-formed but semantically invalid, and resending it unchanged can never succeed. 409 means it conflicts with the **current state**, and it might succeed later or in another state.

**Schemas**
```
Problem       {type:uri, title:str, status:int, detail:str, instance:str, code:ProblemCode, request_id:uuid,
               errors:[{loc:[str|int], msg:str, type:str}]|null}
Clinic        {id:uuid, name:str, timezone:str}
WorkingWindow {weekday:int 1..7, start_time:"HH:MM", end_time:"HH:MM"}
Doctor        {id, full_name, specialty, clinic:Clinic, working_hours:[WorkingWindow]}
Slot          {starts_at:datetime, ends_at:datetime}
Availability  {doctor_id, date:"YYYY-MM-DD", timezone:str, slot_minutes:30, slots:[Slot]}
Patient       {id, full_name, phone:str|null, email:str|null, created_at}
Appointment   {id, doctor_id, patient_id, starts_at, ends_at, status:"booked"|"cancelled",
               cancellation_reason:str|null, cancelled_at:datetime|null, created_at, updated_at}
AppointmentWithDoctor = Appointment & {doctor:{id, full_name, specialty}}
```

| # | Method & path | Request | Success | Errors |
|---|---|---|---|---|
| 1 | GET /healthz | - | 200 `{status:"ok"}` (never touches the DB) | - |
| 2 | GET /readyz | - | 200 `{status:"ok"}` (`SELECT 1`) | 503 DB_UNAVAILABLE |
| 3 | GET /problems | - | 200 `[{code, slug, title, status, description}]` | - |
| 4 | GET /problems/{slug} | - | 200 one entry | 404 PROBLEM_NOT_FOUND |
| 5 | GET /doctors | - | 200 `{items:[Doctor]}` (active only, by full_name) | - |
| 6 | GET /doctors/{doctor_id} | - | 200 Doctor | 404 DOCTOR_NOT_FOUND (incl. inactive); 422 VALIDATION_ERROR (non-UUID) |
| 7 | GET /doctors/{doctor_id}/availability?date=YYYY-MM-DD | `date` required, clinic-local | 200 Availability. `[]` for a past date, non-working day or full day. Excludes booked slots and `starts_at < now+60m` | 404 DOCTOR_NOT_FOUND; 422 VALIDATION_ERROR; 422 DATE_OUT_OF_RANGE |
| 8 | POST /patients | `{full_name:str 2..200, phone?:E.164, email?:EmailStr}` | 201 Patient + `Location: /patients/{id}` | 409 PATIENT_PHONE_EXISTS; 422 VALIDATION_ERROR |
| 9 | POST /appointments | header `Idempotency-Key?` (T2); body `{doctor_id:uuid, patient_id:uuid, starts_at:str AwareDatetime}` | 201 Appointment + `Location`; on replay 201 + `Idempotent-Replayed: true` (T2) | 422 VALIDATION_ERROR, TIMEZONE_REQUIRED, UNKNOWN_DOCTOR, UNKNOWN_PATIENT, IDEMPOTENCY_KEY_REUSED (T2), SLOT_IN_PAST, BOOKING_TOO_SOON, DATE_OUT_OF_RANGE, SLOT_MISALIGNED, OUTSIDE_WORKING_HOURS; 409 SLOT_TAKEN, PATIENT_DOUBLE_BOOKED, CONCURRENT_UPDATE, IDEMPOTENCY_KEY_CONSUMED (T2); 503 DB_UNAVAILABLE |
| 10 | GET /appointments/{id} | - | 200 Appointment | 404 APPOINTMENT_NOT_FOUND; 422 VALIDATION_ERROR |
| 11 | PATCH /appointments/{id}/cancel | `{reason:str 3..500 after trim}` | 200 Appointment (cancelled; slot bookable immediately) | 404 APPOINTMENT_NOT_FOUND; 409 APPOINTMENT_ALREADY_CANCELLED, APPOINTMENT_ALREADY_STARTED, CONCURRENT_UPDATE; 422 VALIDATION_ERROR |
| 12 | PATCH /appointments/{id}/reschedule | `{starts_at:str AwareDatetime}` | 200 Appointment (same id, new times); 200 no-op if the start is unchanged | 404 APPOINTMENT_NOT_FOUND; 409 APPOINTMENT_ALREADY_CANCELLED, APPOINTMENT_ALREADY_STARTED; 422 UNKNOWN_DOCTOR (inactive), then every slot 422 from POST; 409 SLOT_TAKEN, PATIENT_DOUBLE_BOOKED, CONCURRENT_UPDATE |
| 13 | GET /patients/{patient_id}/appointments?limit=1..100 (default 50) | - | 200 `{items:[AppointmentWithDoctor], next_cursor:null}`: booked, `starts_at > :now`, `ORDER BY starts_at, id`, one JOIN (no N+1). `next_cursor` is reserved and always null in v1 | 404 PATIENT_NOT_FOUND; 422 VALIDATION_ERROR |
| 14 | GET /docs, /redoc, /openapi.json | - | 200 (public). At the public URL they are served at the web origin root as **static** routes (`dynamic = "force-static"`), built at `next build` from the committed `contracts/openapi.json` with `servers: [{"url": "/api"}]` injected so Swagger's "Try it out" calls the proxy; they never fetch from Cloud Run, so no query string or cache miss can turn them into Cloud Run egress (§12.4; ~~proxied with `s-maxage=600`~~, superseded because the CDN cache key includes the query string, deduced). `$PUBLIC_API/docs`, `/redoc` and `/openapi.json` answer 308 to the root routes. FastAPI's own `/docs`, `/redoc`, `/openapi.json` stay for local use and the tag-URL smoke | - |

**Validation order (fixed).**
- **#9:** schema → doctor (active) → patient → idempotency (T2) → past → too soon → horizon → misaligned → outside hours → insert/constraint.
- **#12:** lock → 404 → cancelled → started → same-start no-op → doctor active → past → too soon → horizon → misaligned → outside hours → update/constraint.
- **TIMEZONE_REQUIRED** is returned only when *every* validation error is pydantic's `timezone_aware`. Otherwise the response is VALIDATION_ERROR with `errors[]`.

**STRETCH endpoints (exist only if the matching WP ships).** Rows 1-14 above are not changed by any of this. The only change visible to existing clients is that the `ProblemCode` enum gains the new codes below (additive widening; the contract guard, §8 stretch preamble rule 3, proves the existing `paths` objects are byte-identical and that `components` changes only by new `ProblemCode` members, new `Admin*` schemas and, with S3, a `securitySchemes` entry).

Schemas:
```
AdminMetrics   {generated_at:datetime, timezone:str, cursor:str /^\d+\.\d+$/, days:int,
                hourly:[{hour_start:datetime, booked:int, cancelled:int, rescheduled:int}],
                utilization:[{doctor_id:uuid, full_name:str, date:"YYYY-MM-DD",
                              booked_slots:int, total_slots:int, ratio:float 0..1}]}
AdminStreamTicket {ticket:str, expires_at:datetime}
AppointmentEvent v1 (SSE data; JSON Schema contracts/events/appointment-event.v1.schema.json)
               {schema_version:1, event_id:str "<txid>.<id>", type:"booked"|"cancelled"|"rescheduled",
                doctor_id:uuid, from_starts_at:datetime|null, to_starts_at:datetime|null,
                local_date:"YYYY-MM-DD", from_local_date:"YYYY-MM-DD"|null, occurred_at:datetime}
                additionalProperties:false. Never carries appointment_id, patient_id, names, phones, emails or reasons.
```

| # | Service · Method & path | Request | Success | Errors | Tier |
|---|---|---|---|---|---|
| 15 | api · GET /admin/metrics?days=1..14 (default 7) | after S3: `Authorization: Bearer <Google ID token>` | 200 AdminMetrics, `Cache-Control: no-store`. Hourly buckets are clinic-local hours over the last `days` days up to now; utilization is for today (clinic-local), `total_slots` from `domain.slots` without the lead filter | 422 VALIDATION_ERROR; 503 DB_UNAVAILABLE; after S3: 401 ADMIN_AUTH_REQUIRED (+ `WWW-Authenticate: Bearer`), 403 ADMIN_FORBIDDEN, 503 ADMIN_AUTH_UNAVAILABLE (JWKS fetch failed, + `Retry-After: 5`) | S1 (auth S3) |
| 16 | api · POST /admin/stream-ticket | `Authorization: Bearer <Google ID token>` (after S3); no body | 200 AdminStreamTicket (HMAC-SHA256 over `{v:1, aud:"clinic-realtime", exp}`, TTL `STREAM_TICKET_TTL_SECONDS`=60; no `jti`, so a ticket is reusable until it expires), `Cache-Control: no-store`. With `ADMIN_AUTH_ENABLED=false` (local, CI, Schemathesis, and prod before S3 flips the flag) `require_admin` is a no-op and this returns 200 with a ticket to any caller; the gateway ignores tickets while `STREAM_AUTH_REQUIRED=false`. Both flag values are tested in `test_admin_auth.py`. **Amended by §12.4:** the route ships with S1 (WP-S1c) and every 200 first debits `STREAM_TICKET_DEBIT_SECONDS` from the current clinic-local month in `stream_budget` in one statement; the gateway requires tickets in Cloud Run from S1 on (`STREAM_AUTH_REQUIRED=true`), so before S3 any caller gets a ticket, but only within the budget | 503 STREAM_BUDGET_EXHAUSTED (monthly budget spent, + `Retry-After` in seconds to the next clinic-local month, capped at 86,400); after S3: 401 ADMIN_AUTH_REQUIRED; 403 ADMIN_FORBIDDEN; 503 ADMIN_AUTH_UNAVAILABLE (declared unconditionally; returned only when the flag is true) | S1 (auth S3) |
| 17 | realtime · GET /stream?cursor=<txid>.<id>[&ticket=] (public path `/api/stream` through the proxy) | header `Last-Event-ID` on resume (takes precedence over `cursor`); no cursor = start at the current horizon | 200 `text/event-stream`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: WEB_ORIGIN`. First frame `retry: 3000`. Frames `id: <txid>.<id>`, `event: appointment.booked|appointment.cancelled|appointment.rescheduled`, `data: <AppointmentEvent v1>`. `: hb` comment every 15 s. `event: reset` if the cursor is more than 1,000 events behind (client refetches /admin/metrics). `event: reconnect` then close at ~290 s or on SIGTERM. Event ids are compared as tuples, never as strings or `Number`: clients dedupe with a `Set` of ids and, when they need order, parse both parts to `BigInt` and compare `(txid, id)` (`"9.5"` sorts before `"10.1"`) | 422 INVALID_CURSOR; 429 STREAM_LIMIT_REACHED (more than 3 concurrent streams from one IP on this instance, + `Retry-After: 10`); 503 STREAM_CAPACITY (more than 50 streams on this instance, + `Retry-After: 5`); 503 DB_UNAVAILABLE; ~~after S3: 401 ADMIN_AUTH_REQUIRED~~ with `STREAM_AUTH_REQUIRED=true` (Cloud Run from S1, §12.4): 401 STREAM_TICKET_REQUIRED (missing, malformed, expired or wrongly signed ticket) | S1 |
| 18 | realtime · GET /healthz | - | 200 `{status:"ok"}` (never touches the DB) | - | S1 |
| 19 | web · POST /ui/appointments (Next route handler, same origin; moved from `/api/appointments` because `/api/*` is the proxy's, §12.3) | body `{doctor_id, patient_id, starts_at, turnstile_token}`; header `Idempotency-Key?` | Whatever `POST /appointments` returned (status, body, `Location`, `Idempotent-Replayed`), passed through unchanged | 422 BOT_CHECK_FAILED (siteverify `success:false`, including `timeout-or-duplicate`); 503 BOT_CHECK_UNAVAILABLE (siteverify unreachable or > 3 s; fail closed, nothing forwarded); otherwise the API's own problems | S4 |

**Stretch problem types** (`type = {PUBLIC_BASE_URL}/problems/<slug>`, added to `docs/api-errors.md` and the FastAPI catalogue so every `type` URI resolves, including the ones the gateway and the web route emit):

| Code | Status | Emitted by | When | Added by (one owner per code) |
|---|---|---|---|---|
| ADMIN_AUTH_REQUIRED | 401 | api (~~realtime~~: the gateway uses STREAM_TICKET_REQUIRED since §12.4) | No credential, or a token that fails signature, `alg`, `iss`, `aud` or `exp` checks | WP-S3 |
| ADMIN_FORBIDDEN | 403 | api | A valid Google ID token whose `email` is unverified or not in `ADMIN_EMAILS` | WP-S3 |
| ADMIN_AUTH_UNAVAILABLE | 503 | api | Google JWKS could not be fetched and no cached key matches the `kid` | WP-S3 |
| INVALID_CURSOR | 422 | realtime | `cursor` / `Last-Event-ID` is not `<digits>.<digits>` | WP-S1a |
| STREAM_LIMIT_REACHED | 429 | realtime | Per-IP concurrent stream cap exceeded on the instance | WP-S1a |
| STREAM_CAPACITY | 503 | realtime | Per-instance stream cap exceeded | WP-S1a |
| STREAM_TICKET_REQUIRED | 401 | realtime | `STREAM_AUTH_REQUIRED=true` and the ticket is missing, malformed, expired or wrongly signed (§12.4) | WP-S1a |
| STREAM_BUDGET_EXHAUSTED | 503 | api | The month's stream budget is spent (§3.9, §12.4) | WP-S1a |
| BOT_CHECK_FAILED | 422 | web route | Turnstile token missing, invalid, expired or already used | WP-S4 |
| BOT_CHECK_UNAVAILABLE | 503 | web route | siteverify unreachable or timed out | WP-S4 |

The owning WP adds its codes, and only its codes, in one PR: `app/domain/errors.py`, `docs/api-errors.md`, the regenerated `contracts/openapi.json` and `web/src/api/generated/**`, and copy in `web/src/lib/errors.ts`. Widening `ProblemCode` without the `errors.ts` entries would break `tsc` and `next build` (`satisfies Record<ProblemCode, string>`), and skipping the regeneration would turn `contract-drift` red.

---

# 7. Repository layout & conventions

```
.
├── .circleci/config.yml
├── .github/pull_request_template.md
├── .husky/{pre-commit,pre-push,commit-msg}
├── .zap/rules.tsv
├── .editorconfig  .gitattributes  .gitignore  .gitleaks.toml  .trivyignore  .env.example
├── commitlint.config.mjs  package.json  pnpm-workspace.yaml  pnpm-lock.yaml
├── Makefile
├── docker-compose.yml
├── README.md
├── contracts/openapi.json                     # generated, committed
├── contracts/events/appointment-event.v1.schema.json   # STRETCH S1: hand-written JSON Schema 2020-12, versioned
├── docs/
│   ├── architecture/PLAN.md                   # this file
│   ├── adr/README.md, 0001-…md … 0023-…md
│   ├── api-errors.md                          # error catalogue (tested against code)
│   ├── versions.md                            # resolved pins + platform facts (WP-00)
│   ├── runbooks/{bootstrap-gcp.md, neon.md, rollback.md, base-image-cve.md}
│   ├── evidence/gate-b.txt                    # STRETCH entry: pasted verify_claims.py output + timestamp (§0)
│   └── ai/                                    # local prompt log, gitignored
├── scripts/{verify_claims.py, docs_check.py, migration_lint.sh}
├── scripts/cost_check.sh                      # $0 audit: --static (config lint) and --live (gcloud reads), WP-12a
├── scripts/verify_stream.py                   # STRETCH S1: SSE smoke run after ship-realtime
├── services/                                  # STRETCH S1 only; absent if S1 is cut
│   └── realtime/                              # Go module, no framework
│       ├── go.mod  go.sum  Dockerfile  .dockerignore   # distroless static, CGO_ENABLED=0, uid nonroot
│       ├── cmd/realtime/main.go               # config, server, SIGTERM drain (8 s)
│       └── internal/
│           ├── cursor/{cursor.go, cursor_test.go}            # parse/format/compare "<txid>.<id>"
│           ├── feed/{query.go, poller.go, poller_test.go,
│           │         poller_integration_test.go}             # build tag: integration (real PG 17)
│           ├── sse/{handler.go, handler_test.go, limiter.go, limiter_test.go, clientip.go}
│           ├── event/{event.go, event_test.go}               # payload v1, validated against the JSON Schema
│           ├── ticket/{ticket.go, ticket_test.go}            # S1 since §12.4 (was S3): HMAC stream ticket
│           └── problem/problem.go                            # problem+json, types point at the API's /problems
├── infra/
│   ├── bootstrap.sh                           # state bucket (us-east1); one-time Cloud Run service + web-proxy/smoke invokers (no allUsers)
│   └── terraform/{versions.tf, providers.tf, backend.tf, variables.tf, apis.tf,
│                  artifact_registry.tf, iam.tf, wif.tf, secrets.tf, budget.tf, outputs.tf,
│                  terraform.tfvars.example,
│                  wif_vercel.tf, monitoring.tf, logging.tf}  # $0 audit: Vercel WIF pool; daily egress alert; 401/403 log exclusion (§12.4)
├── backend/
│   ├── pyproject.toml  uv.lock  .python-version  Dockerfile  .dockerignore  alembic.ini
│   ├── docker/initdb/01-roles.sql             # local/CI only: creates clinic_app
│   ├── docker/initdb/02-realtime-role.sql     # STRETCH S1, local/CI only: creates clinic_realtime
│   ├── migrations/{env.py, script.py.mako, versions/{0001_initial.py, 0002_idempotency.py,
│   │                                                   0003_event_cursor.py, 0004_stream_budget.py}}   # 0003, 0004: STRETCH S1
│   ├── scripts/export_openapi.py
│   ├── app/
│   │   ├── main.py                            # create_app(settings)
│   │   ├── core/{config.py, clock.py, logging.py, problems.py, middleware.py, cors.py}
│   │   ├── db/{base.py, session.py}
│   │   ├── models/{clinic.py, doctor.py, working_hours.py, patient.py, appointment.py, appointment_event.py}
│   │   ├── schemas/{common.py, problem.py, doctor.py, availability.py, patient.py, appointment.py}
│   │   ├── domain/{errors.py, slots.py, booking_rules.py, events.py}
│   │   ├── repositories/{errors.py, doctors.py, patients.py, appointments.py, events.py}
│   │   ├── services/{availability.py, booking.py, patients.py}
│   │   ├── api/{deps.py, routers/{health.py, problems.py, doctors.py, patients.py, appointments.py}}
│   │   ├── api/routers/admin.py               # STRETCH S1 (metrics), S3 (stream-ticket)
│   │   ├── services/metrics.py  repositories/metrics.py  schemas/admin.py   # STRETCH S1
│   │   ├── core/{admin_auth.py, stream_ticket.py}              # admin_auth.py STRETCH S3; stream_ticket.py STRETCH S1 since §12.4
│   │   ├── repositories/stream_budget.py                     # STRETCH S1 (§12.4)
│   │   └── scripts/seed.py
│   └── tests/
│       ├── conftest.py                        # db fixtures, FakeClock, client
│       ├── unit/{test_slots.py, test_booking_rules.py, test_error_catalogue.py, test_log_redaction.py}
│       ├── integration/{test_health.py, test_doctors.py, test_availability.py, test_post_appointments.py,
│       │                test_cancel.py, test_reschedule.py, test_patient_appointments.py, test_patients.py,
│       │                test_constraints_exist.py, test_problem_shape.py, test_db_roles.py,
│       │                test_error_logging.py, test_idempotency.py}
│       ├── integration/{test_event_cursor_column.py, test_admin_metrics.py,
│       │                test_admin_auth.py, test_stream_budget.py}   # STRETCH S1, S3
│       ├── concurrency/{test_race_same_slot.py, test_race_patient.py, test_race_reschedule.py,
│       │                test_race_swap.py, test_race_cancel_vs_reschedule.py,
│       │                test_naive_control.py, test_race_idempotency.py}
│       ├── contract/test_schemathesis.py
│       └── migrations/test_roundtrip.py
└── web/                                       # one Vercel project, clinic-web, iad1 (§12.3)
    │   # ---- lean core (WP-11 Part C): the public URL; never cut ----
    ├── package.json  next.config.ts  tsconfig.json  vercel.json   # vercel.json: git deploys off, regions ["iad1"]
    ├── src/app/{layout.tsx, page.tsx}         # page.tsx: minimal landing page linking /docs, /redoc, /openapi.json, /api/healthz
    ├── src/app/api/[...path]/route.ts         # the proxy; /api/stream -> realtime, rest -> api; the only route under app/api/
    ├── src/app/{docs, redoc, openapi.json}/route.ts   # force-static, built from the snapshot; no upstream fetch (§12.4; was proxies with s-maxage=600)
    ├── scripts/snapshot-openapi.mjs           # prebuild: contracts/openapi.json -> src/generated/openapi.public.json, servers [/api]
    ├── src/lib/proxy/{gcp-id-token.ts, forward.ts, call-api.ts, rate-limit.ts}
    ├── tests/proxy/{forward.test.ts, gcp-id-token.test.ts, docs-routes.test.ts, route-layout.test.ts, location.test.ts}
    │   # ---- T2, cut first (WP-15, WP-16) ----
    ├── openapi-ts.config.ts  components.json
    ├── src/app/{providers.tsx, doctors/page.tsx, doctors/[id]/page.tsx, appointments/page.tsx}
    ├── src/components/{slot-grid.tsx, book-dialog.tsx, cancel-dialog.tsx, reschedule-dialog.tsx,
    │                   theme-toggle.tsx, patient-picker.tsx, demo-banner.tsx, ui/*}
    ├── src/lib/{query-client.ts, errors.ts, patient.tsx, idle.ts, env.ts}
    ├── src/api/generated/**                   # hey-api output, committed
    ├── tests/{errors.test.ts, slot-grid.test.tsx}
    │   # ---- STRETCH additions below; each exists only if its WP ships ----
    ├── src/app/admin/{layout.tsx, page.tsx}                         # S1 (WP-S1d); gated by S3
    ├── src/components/admin/{bookings-chart.tsx, utilization-chart.tsx, stream-status.tsx}
    ├── src/lib/{stream.ts, event-schema.ts}                         # S1: reconnect manager, zod for event v1
    ├── src/app/{sw.ts, manifest.ts, ~offline/page.tsx}  public/icons/*   # S2
    ├── src/auth.ts  src/app/auth/[...nextauth]/route.ts            # S3 (Auth.js basePath "/auth"; /api/* is the proxy's)
    ├── src/app/admin/api/{metrics/route.ts, stream-ticket/route.ts} # S3: server-side id_token forwarding
    ├── src/app/ui/appointments/route.ts  src/lib/turnstile.ts       # S4 (moved off /api/*)
    └── tests/{stream.test.ts, event-schema.test.ts, sw-config.test.ts, turnstile-route.test.ts}
```

**Conventions**
- **Python:** ruff rules E, F, I, B, UP, S, ASYNC, TID. Banned APIs via `flake8-tidy-imports`: `datetime.datetime.now`, `datetime.datetime.utcnow`, `datetime.datetime.today`, `datetime.date.today`, `time.time`, all allowed only in `app/core/clock.py` through a per-file ignore. `mypy --strict`. No `print`. No `Any` without a comment explaining why it is safe.
- **TS:** `strict: true`, no `any`.
- **Go (STRETCH S1):** `gofmt -l` empty, `go vet`, errors returned and wrapped with `%w` (no panics outside `main`), `context.Context` on every DB call, `log/slog` JSON handler with the ADR-0019 field names, no global mutable state outside `main`. Dependencies: pgx v5 only at runtime; a JSON Schema validator is allowed in `_test.go` files only.
- **Constraint and index names** follow `uq_|ck_|ix_<table>_<what>`. They are part of the contract and are tested.
- **Error codes:** UPPER_SNAKE, with kebab-case slugs.
- **Middleware is pure ASGI** (no `BaseHTTPMiddleware`). No GZip middleware.
- **Config** (pydantic-settings, `backend/app/core/config.py`):

| Variable | Default / notes |
|---|---|
| `DATABASE_URL` | required. `postgresql+asyncpg://…?ssl=require`. A config validator **rejects `sslmode`/`channel_binding` query params** with a clear message, because asyncpg does not accept them (unverified; WP-11 confirms via `/readyz`) |
| `DB_POOL_SIZE` | 5 (30 in race tests) |
| `BOOKING_MIN_LEAD_MINUTES` | 60 |
| `BOOKING_HORIZON_DAYS` | 90 |
| `WEB_ORIGIN` | `http://localhost:3000` locally |
| `PUBLIC_BASE_URL` | used for problem `type` URIs |
| `LOG_LEVEL` | info |
| `GIT_SHA` | `unknown` |
| `ADMIN_AUTH_ENABLED` | STRETCH S3. `false` until S3 ships; `/admin/*` is public (non-PII aggregates) while false. While false, `require_admin` is a no-op and `POST /admin/stream-ticket` returns 200 with a ticket (§6 row 16) |
| `GOOGLE_OAUTH_CLIENT_ID` | STRETCH S3. Expected `aud` of admin ID tokens (an identifier, not a secret) |
| `ADMIN_EMAILS` | STRETCH S3. Comma-separated, lowercased exact match; empty means nobody is admin |
| `STREAM_TICKET_KEY` | STRETCH ~~S3~~ S1 since §12.4. Secret Manager `clinic-stream-ticket-key`, mounted on api and realtime only. Required when `ADMIN_AUTH_ENABLED=true`; when false and unset, a random per-process key is generated at start-up |
| `STREAM_TICKET_TTL_SECONDS` | STRETCH ~~S3~~ S1 since §12.4. 60 |
| `STREAM_TICKET_DEBIT_SECONDS` | STRETCH S1 (§12.4). 700 = 2 concurrent streams × (60 s TTL + 290 s stream) |
| `STREAM_BUDGET_SECONDS` | STRETCH S1 (§12.4). 345,600 (96 connected hours a month; arithmetic in §13.4) |

  **`clinic-realtime` config** (STRETCH S1, env only, parsed once at start, invalid values fail start-up): `DATABASE_URL` (secret `clinic-database-url-realtime`, role `clinic_realtime`, direct endpoint), `WEB_ORIGIN`, `PUBLIC_BASE_URL` (problem `type` URIs point at the API's catalogue), `POLL_INTERVAL_MS`=1000, `MAX_STREAMS_PER_INSTANCE`=50, `MAX_STREAMS_PER_IP`=3, `STREAM_MAX_SECONDS`=290, `HEARTBEAT_SECONDS`=15, `DB_MAX_CONNS`=2, `DB_MAX_CONN_IDLE_SECONDS`=60 (the pool is also closed whenever the subscriber count returns to 0), `LAG_WARN_SECONDS`=10, `STREAM_AUTH_REQUIRED`=false locally (~~true after S3~~ true in Cloud Run from S1, §12.4), `STREAM_TICKET_KEY` (~~S3~~ S1), ~~`TRUST_CLOUD_RUN_XFF`=true in Cloud Run, false locally~~ `TRUST_PROXY_CLIENT_IP`=true in Cloud Run, false locally (struck by §12.4; see the amendment below).
  **Amended by the $0 audit:** `MAX_STREAMS_PER_INSTANCE`=1 in Cloud Run (concurrency 1; 50 stays the local default), and the client IP comes from `X-Client-IP` set by the front door when `TRUST_PROXY_CLIENT_IP`=true (Cloud Run), replacing `TRUST_CLOUD_RUN_XFF` there, because behind the front door the right-most `X-Forwarded-For` entry is Vercel's address (ADR-0012 amendment).

  **`web` proxy config** ($0 audit; lean core since §12.3, where the separate project's config merged into `web`; server-only Vercel env, identifiers only, no secrets): `API_URL` (the `clinic-api` run.app URL), `REALTIME_URL` (S1), `API_AUDIENCE`=`clinic-api`, `REALTIME_AUDIENCE`=`clinic-realtime`, `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_IDENTITY_POOL_ID`=`vercel`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`=`vercel`, `GCP_SERVICE_ACCOUNT_EMAIL`=`clinic-web@<project>.iam.gserviceaccount.com`, `RATE_LIMIT_PER_MINUTE`=120, ~~`DOCS_CACHE_SECONDS`=600~~ (superseded by §12.4: the doc routes are static), plus the CLI identifiers `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` in the `vercel-prod` CircleCI context (WP-11 Part C0). The UI's generated client uses the same-origin base `/api`, and S3/S4 server routes call `call-api.ts` in-process (§3.10). With `VERCEL_ENV` unset (local), no ID token is minted and requests go to `API_URL` as given.

  **`web` config added by stretch WPs:** `NEXT_PUBLIC_REALTIME_URL` (S1), `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `ADMIN_EMAILS` (S3; UX gate only, the API is the boundary), `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (S4), ~~`API_BASE_URL` (S3 and S4, server-only: used by `/admin/api/*` and `/api/appointments`; whichever of the two WPs lands first adds it)~~ (superseded by §12.3: those routes call the proxy's `call-api.ts` in-process), `TURNSTILE_EXPECTED_HOSTNAME` (S4, the web domain checked against siteverify's `hostname`).

  `.env.example` lists every variable with placeholders. There are no secrets in the repo.
- **Commits:** Conventional Commits, `type(scope): subject`. Types: feat, fix, test, docs, ci, build, refactor, chore. Scopes: api, db, domain, web, ci, infra, docs, and `realtime`, `admin` for stretch work. **No trailers of any kind** (ADR-0020).
- **Branches:** `feat/wp-07-booking-endpoints`, `ci/wp-10-verify-workflow`, `docs/wp-17-readme`.
- **PRs:** one per WP, squash-merge, PR title = commit subject. `.github/pull_request_template.md`:
  ```
  ## What
  ## Why (assessment line this serves)
  ## How verified (commands + observed output)
  ## Tech debt incurred (or "none")
  ## Checklist
  - [ ] make lint typecheck test passes locally
  - [ ] new error codes added to docs/api-errors.md
  - [ ] README/ADR updated if a decision changed
  ```
- **Hooks:**
  - `.husky/pre-commit`: `gitleaks git --pre-commit --staged --no-banner && pnpm exec lint-staged`. Confirm the subcommand with `gitleaks --help` on the resolved version (WP-00). lint-staged runs `ruff check --fix` and `ruff format` on `backend/**/*.py`, and eslint + prettier on `web/**/*.{ts,tsx}`.
  - `.husky/pre-push`: `make typecheck test-unit`.
  - `commit-msg`: commitlint.
  - Husky sets `core.hooksPath`, which bypasses the global template hooks, so gitleaks is called explicitly.

---

# 8. Execution plan

**Global rules for every executor**
1. **Versions.** Use the version in the lockfile, or in `docs/versions.md` before a lockfile exists. If a pinned version doesn't exist, use the latest patch of the same minor and record that in `docs/versions.md`.
2. **Evidence.** Never mark anything verified without running the command. The PR body pastes the observed output.
3. **Debt.** Every PR states the tech debt it incurs, or "none".
4. **Edits.** Edit additively. Never sweep-remove adjacent lines.
5. **Shell.** In scripts use `docker compose` (never the `dc` alias) and `command ls`. Never type `gl`, which is aliased to a gitleaks scan.
6. **Git.** No commit trailers. Never use `--no-verify`.
7. **Reflection.** Never write README §11 content on the engineer's behalf.
8. **Infra.** Never provision min-instances > 0, a load balancer, a NAT, Redis or Cloud SQL, a static IP, a VPC connector, a VM, a GKE cluster, an Artifact Registry remote repository, or user-managed secret replication. Before any `terraform apply`, run `terraform show -no-color tfplan | rg -n 'min_instance|google_compute_router_nat|google_compute_global_address|google_compute_forwarding_rule|google_redis|google_sql|google_compute_address|google_vpc_access_connector|google_compute_instance|google_container_cluster|google_compute_region_network_endpoint_group|google_compute_backend_service|REMOTE_REPOSITORY|user_managed'` and STOP if anything matches.
9. **Clock.** Tests that depend on "now" use `FakeClock(datetime(2026, 10, 19, 4, 0, tzinfo=UTC))`, which is Monday 07:00 EAT. Manual checks never hard-code a date. Use "the first date D where availability returns ≥ 1 slot".
10. **Executor tiers.** Tier **S** is mechanical work from an established pattern. Tier **M** is standard implementation work. Tier **E** is the engineer personally (approvals, cloud accounts, §11).
11. **Cost ($0 rule, §13).** Every `gcloud run deploy` passes `--min-instances 0` and `--max-instances`; every `gcloud run jobs deploy` passes `--task-timeout` and `--max-retries 0`. Never use `gcloud run deploy --source` or `gcloud builds submit`, never enable `containerscanning`, `ondemandscanning` or `cloudbuild`, never add a GCP secret without recounting §13.2 (6 active versions), never add a resource outside the regions in §13 (us-east4; state bucket us-east1), never enable CircleCI Docker layer caching or a large/Gen2 class, never start a Vercel Pro trial or add a card to Vercel, Neon or CircleCI. The plan grep in rule 8 also matches `google_cloud_scheduler|google_monitoring_uptime_check|containerscanning|ondemandscanning|cloudbuild|europe-west|STANDARD_IA|dual-region|multi-region`, and STOPs on any hit. Never pass `--allow-unauthenticated` or `--no-invoker-iam-check` (either makes a service public without any `allUsers` binding), `--no-cpu-throttling`, `--vpc-connector`, `--network`, `--subnet`, `--vpc-egress`, `--gpu`, or a service-level `--min` above 0. **Added by the hosting lock review (§12.4):** never pass `--scaling` (any value; a number switches the service to manual scaling, whose instances bill while idle: "billed as idle minimum instances" under request-based billing, docs.cloud.google.com/run/docs/configuring/services/manual-scaling, read 2026-10-16), never write the `run.googleapis.com/scalingMode` or `run.googleapis.com/manualInstanceCount` annotations, never run `gcloud run services replace` (a YAML deploy bypasses every flag ban) and never create a Cloud Run worker pool (`gcloud run worker-pools`, `google_cloud_run_v2_worker_pool`). Never pull an image from `*-docker.pkg.dev` anywhere except Cloud Run itself (Artifact Registry internet egress is billed from byte 0); CI scans the image it has just built, before the push. Every image build passes `--provenance=false --sbom=false`, so one push creates exactly one Artifact Registry version. `bash scripts/cost_check.sh --static` must pass before any PR is opened.

**Parallel groups.** [P-A] WP-01 ∥ WP-02 ∥ WP-11a (user-gated cloud set-up). [P-B] WP-04 ∥ WP-05 after WP-03. [P-C] WP-08 ∥ WP-09 after WP-07. [P-D] WP-13 ∥ WP-14 ∥ WP-15 after WP-12.

### WP-00 Version and platform-fact resolution (tier S), no dependencies
- **Already verified on 2026-10-16** (registry query by `pip index versions` / `npm view`): fastapi 0.143.2, sqlalchemy 2.1.4, uvicorn 0.54.0, asyncpg 0.32.0, alembic 1.20.0, pydantic 2.14.1, schemathesis 4.31.1, semgrep 1.181.0, pip-audit 2.10.1, pyjwt 2.15.1 (unused in v1), next 16.4.2, react 19.3.1, @tanstack/react-query 5.104.3, zod 4.6.7, @hey-api/openapi-ts 0.99.0, shadcn 4.21.5, next-themes 0.4.6.
- **Correction found:** `@hey-api/client-fetch` is deprecated. Since openapi-ts 0.73.0 it is bundled into `@hey-api/openapi-ts` (npm deprecation notice), so it is **not** installed separately. The plugin name `@hey-api/client-fetch` stays in the config.
- **Still to resolve and write to `docs/versions.md`:**
  - **Images and binaries:** `docker manifest inspect` for `postgres:17-alpine`, `python:3.12-slim` (record the digest), `ghcr.io/zaproxy/zaproxy:stable`, and a real `cimg/postgres:17.x` tag. Also the gitleaks 8.30.1 and trivy 0.76.0 release binaries, plus `gitleaks --help` (confirm the `git --pre-commit --staged` subcommand).
  - **uv:** the uv version that matches the local `uv --version`, which CI pins too so the lockfile format agrees.
  - **CircleCI:** read the docs for `serial-group`, context expression restrictions on the Free plan, OIDC V2 claim names (`oidc.circleci.com/project-id`, `oidc.circleci.com/vcs-ref`), and the GitHub App trigger options.
  - **Cloud Run:** read the docs on whether `gcloud run deploy --no-traffic` is rejected for a new service, and whether the free tier applies to europe-west3 (pricing page). **Answered by the $0 audit (2026-10-16, Cloud Billing catalog):** europe-west3 is Tier 2; us-east4 is Tier 1 and in the North America free egress SKU; the region is now us-east4 (ADR-0014).
  - **Cost facts still to confirm and write to `docs/versions.md`** ($0 audit; each with URL and date): (a) whether `--cpu 0.25 --memory 256Mi --concurrency 1` is accepted and whether concurrency must be 1 below 1 vCPU (Cloud Run CPU/memory limits docs); (b) whether a custom audience (`--add-custom-audiences`) is accepted for a tag URL; (c) whether the `google_billing_budget` Terraform resource can create a spend-cap budget, else the console/Budget API steps for the runbook, and whether this billing account type is eligible (spend caps are for first-party customers); (d) the metric name for Cloud Run sent bytes used by the egress alert (`run.googleapis.com/container/network/sent_bytes_count` expected); (e) `gcloud storage buckets create --soft-delete-duration=0` and whether soft-deleted bytes bill as storage; (f) the Vercel request header that carries the client IP (~~and Vercel Hobby's default function memory~~ settled by the hosting lock review: Hobby default and maximum are both 2 GB / 1 vCPU and duration is 300 s default and maximum, "including streamed responses", vercel.com/docs/functions/limitations, last updated 2026-08-24, read 2026-10-16), and whether `vercel env pull` writes a development `VERCEL_OIDC_TOKEN` (used by Part C0's negative test); (g) the Artifact Registry cleanup-policy JSON keys (`keepCount`, `olderThan`, `tagState`); (h) whether the `p/python`, `p/typescript` and `p/owasp-top-ten` Semgrep rulesets run without login; (i) whether Artifact Registry to Cloud Run image pulls inside `us-east4` carry any network charge (expected none, deduced; this pass could not read the network section of the Artifact Registry pricing page), from the "Network" section of cloud.google.com/artifact-registry/pricing and the Billing Catalog SKUs for Artifact Registry. **(i) is a precondition of WP-12's first deploy (§12.4):** if the page cannot be read, the first release goes out and no further release runs until C17 shows no Artifact Registry egress line in the Billing report after 48 hours; (j) the JSON paths in `gcloud run services describe --format=json` of the service annotation `run.googleapis.com/invoker-iam-disabled` (placed under the service's `metadata`, per docs.cloud.google.com/run/docs/securing/managing-access, read 2026-10-16), of `run.googleapis.com/cpu-throttling`, of a service-level `autoscaling.knative.dev/minScale`, and of `run.googleapis.com/scalingMode` (placed in the service's `metadata.annotations`, values `manual` or `automatic`, per docs.cloud.google.com/run/docs/configuring/services/manual-scaling, read 2026-10-16; confirm the describe output shows it, or its absence for automatic); (k) the size of a docker-buildx build pushed with and without `--provenance=false --sbom=false` (one manifest versus an index plus attestation manifests). (l) **Settled by the hosting lock review:** CircleCI states that "the machines that execute all jobs" run on AWS `us-east-1` and `us-east-2` and GCP `us-east1` and `us-central1` (circleci.com/docs/guides/security/ip-ranges, last updated 2026-09-28, read 2026-10-16), so CI egress is deduced to be in North America; the C19 gate still checks it on every release, because the egress address itself is not documented.
- **Acceptance:** every row in `docs/versions.md` has a value, a source (command or URL) and a date. No row says "assumed".

### WP-01 Repo hygiene skeleton (tier S), depends on WP-00
- **Files:** `.gitignore`, `.gitattributes` (`web/src/api/generated/** linguist-generated`, `contracts/openapi.json linguist-generated`), `.editorconfig`, `README.md` stub with the §9 headings, `.github/pull_request_template.md`, `docs/ai/PROMPTS.md` (header + entry template only), `.env.example`.
- **Local tooling directories and personal instruction files go in `.git/info/exclude`.** That file is local and never committed. Nothing tooling-specific goes in `.gitignore`.
- `.gitignore` covers: `.venv/ __pycache__/ .pytest_cache/ .mypy_cache/ .ruff_cache/ .coverage htmlcov/ node_modules/ .next/ .vercel/ .env .env.* !.env.example *.tfstate* .terraform/ coverage/ junit*.xml zap-report.html`.
- **Acceptance:**
  - `git check-ignore -v <tooling-dir>/x` → prints a match from `.git/info/exclude`.
  - `git check-ignore .env && ! git check-ignore .env.example` → exit 0.
  - `git ls-files | rg -i '^\.git/info'` → no output.

### WP-02 Husky, lint-staged, commitlint (tier S), depends on WP-01
- **Files:** root `package.json` (devDeps husky, lint-staged, @commitlint/cli, @commitlint/config-conventional), `commitlint.config.mjs`, `.husky/*`, `.gitleaks.toml`.
- **Acceptance:**
  - `git commit --allow-empty -m "bad message"` → rejected by commitlint.
  - Staging a file with the gitleaks fake-AWS-key test fixture pattern blocks the commit. Use the fixture pattern only, never a real key.

### WP-03 Backend scaffold, Dockerfile, compose, Makefile (tier S), depends on WP-01
- **Files:** `backend/pyproject.toml`, `backend/uv.lock`, `backend/.python-version` (3.12), `app/main.py`, `app/core/config.py`, `app/api/routers/health.py`, `backend/Dockerfile`, `backend/.dockerignore`, `backend/docker/initdb/01-roles.sql`, `docker-compose.yml`, `Makefile`.
- **Dependencies:**
  - Runtime: fastapi, uvicorn, sqlalchemy[asyncio], asyncpg, alembic, pydantic, pydantic-settings, email-validator, at the WP-00 versions.
  - Dev: pytest, pytest-asyncio, pytest-cov, httpx, schemathesis, ruff, mypy, pip-audit.
- **Dockerfile:**
  - Multi-stage. The builder is `python:3.12-slim@<digest>` + uv, running `uv sync --frozen --no-dev`. The runtime is `python:3.12-slim@<digest>`, uid 10001.
  - `CMD ["sh","-c","exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --timeout-graceful-shutdown 8"]`.
  - `exec` makes uvicorn PID 1 so it receives SIGTERM. **No `--proxy-headers`.**
- **`01-roles.sql`:** `CREATE ROLE clinic_app LOGIN PASSWORD 'clinic_app_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;`. Local and CI only, and documented as such.
- **Compose services:**
  - `db`: postgres:17-alpine, owner user/db `clinic`, mounts `backend/docker/initdb`, healthcheck `pg_isready`.
  - `migrate`: one-shot, `DATABASE_URL` as the owner, runs `alembic upgrade head && python -m app.scripts.seed`.
  - `api`: `DATABASE_URL` as `clinic_app`, depends on `migrate: service_completed_successfully`, port 8080, healthcheck `python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/healthz')"`.
- **Makefile targets:** `help up down logs migrate seed test test-unit test-int test-race test-control contract lint fmt typecheck audit sec openapi gen-client verify docs-check migration-lint`. `up` is `docker compose up -d --wait`.
- **Acceptance:**
  - `make up && curl -fsS localhost:8080/healthz` → `{"status":"ok"}`.
  - `docker compose run --rm --entrypoint id api -u` → `10001`.
  - `docker compose stop api` → logs show uvicorn's shutdown line within 2 s.
  - `make lint typecheck` → exit 0.
- **Docs URLs are fixed (§12.4):** `create_app` builds `FastAPI(root_path="", openapi_url="/openapi.json", docs_url="/docs", redoc_url="/redoc")`; `tests/integration/test_health.py` asserts all three answer 200 and that `app.root_path == ""`. The public doc routes are static copies of the committed contract, but the tag-URL smoke and local use read these.
- **Do not:** add a `/v1` prefix, run migrations on app startup, or use more than one uvicorn worker.

### WP-04 Schema, migration 0001, models, seed (tier M), depends on WP-03
- **Files:** `backend/alembic.ini`, `migrations/env.py` (async template), `versions/0001_initial.py` (DDL exactly as in §5), `app/db/{base.py,session.py}`, `app/models/*.py`, `app/scripts/seed.py`, `tests/migrations/test_roundtrip.py`, `tests/integration/{test_constraints_exist.py,test_db_roles.py}`.
- **`env.py`:** wraps `run_migrations` in `SELECT pg_advisory_lock(727001)` / `pg_advisory_unlock(727001)`, so two migrate executions running at once serialize.
- **`session.py`:**
  - A module-global, lazily created engine: `pool_size=DB_POOL_SIZE, max_overflow=0, pool_pre_ping=True, pool_recycle=240, hide_parameters=True, connect_args={"timeout": 10}`.
  - `async_sessionmaker(expire_on_commit=False)`.
- **Acceptance:**
  - `docker compose exec db psql -U clinic -d clinic -c "\d appointments"` shows `"uq_appt_doctor_slot_booked" UNIQUE, btree (doctor_id, starts_at) WHERE status = 'booked'::text` and the patient twin.
  - `docker compose exec db psql -U clinic -d clinic -tAc "select count(*) from doctors"` → `5`.
  - The same query on `working_hours` → `27`. This value is fixed (§5).
  - Running the seed twice leaves both counts unchanged.
  - `rg -n -i 'delete' backend/app/scripts/seed.py` → no output.
  - `test_db_roles.py`: connected as `clinic_app`, `CREATE TABLE x(i int)` fails with SQLSTATE 42501, and an INSERT into `patients` succeeds.
  - `uv run pytest tests/migrations tests/integration/test_constraints_exist.py tests/integration/test_db_roles.py -q` → all passed.
- **Do not:** use autogenerate for indexes or CHECKs, use PG enums, add time-off tables, or grant DELETE.

### WP-05 Domain: clock, slots, booking rules, error catalogue (tier M), depends on WP-03 (parallel with WP-04)
- **Files:** `app/core/clock.py` (`Clock` Protocol, `SystemClock`, `FakeClock`), `app/domain/slots.py`, `app/domain/booking_rules.py`, `app/domain/errors.py`, `docs/api-errors.md`, `tests/unit/{test_slots.py,test_booking_rules.py,test_error_catalogue.py}`.
- **`generate_slots(windows, booked_starts, tz, local_date, now, lead, slot=30min) -> list[Slot]`:**
  - Convert each window's start and end to aware instants with `datetime.combine(local_date, t, tzinfo=tz)`.
  - Drop any instant that doesn't round-trip (a nonexistent DST time).
  - Step **in UTC** in 30-minute increments while `start + 30m <= end`, then dedupe.
  - Exclude booked starts and anything with `starts_at < now + lead`.
- **`validate_slot(starts_at, windows, tz, now, lead, horizon_days)`:**
  - Computes the grid for the clinic-local date of `starts_at`.
  - Raises, in this order: `SlotInPast`, `BookingTooSoon`, `DateOutOfRange`, `SlotMisaligned` (non-zero seconds or µs, or inside a window but off-grid), `OutsideWorkingHours`.
- **`errors.py`:** a closed hierarchy covering every row of the ADR-0006 table, each entry with `code, status, slug, title`.
- **Acceptance:**
  - `uv run pytest tests/unit -q` → all passed. The suite includes `test_lead_59min_rejected`, `test_lead_60min_accepted`, `test_lunch_break_split`, `test_berlin_dst_spring_forward_skips_nonexistent`, `test_berlin_dst_fall_back_no_duplicate_slots`, `test_misaligned_seconds` and `test_catalogue_matches_docs` (parses the `docs/api-errors.md` table).
  - `uv run pytest tests/unit --cov=app/domain --cov-fail-under=95` passes.
- **Do not:** do I/O in `domain/`, or call any banned time API.

### WP-06 HTTP plumbing: problem+json, request ID, logging, CORS, /problems (tier M), depends on WP-05
- **Files:** `app/core/{problems.py, middleware.py, logging.py, cors.py}`, `app/api/routers/problems.py`, `app/schemas/problem.py`, `tests/integration/test_problem_shape.py`, `tests/unit/test_log_redaction.py`.
- **Middleware:** pure ASGI, covering request ID (an inbound `X-Request-ID` is accepted only if it is a UUID), JSON access log and `Server-Timing`.
- **Handlers:**
  - DomainError.
  - `RequestValidationError`: TIMEZONE_REQUIRED only when all errors are `timezone_aware` (§6), otherwise VALIDATION_ERROR.
  - StarletteHTTPException: 404 NOT_FOUND, 405 METHOD_NOT_ALLOWED.
  - DB-availability exceptions → 503 DB_UNAVAILABLE + `Retry-After: 2`, following the §5 map.
  - A catch-all 500 with an opaque body.
- **Datetime input:** a `BeforeValidator` rejects any non-`str` value with a `VALIDATION_ERROR`.
- **Acceptance:**
  - `curl -s -i localhost:8080/nope` → `HTTP/1.1 404`, `content-type: application/problem+json`, body contains `"code":"NOT_FOUND"`.
  - `curl -s localhost:8080/problems/slot-taken | jq -r .status` → `409`.
  - `docker compose stop db && curl -s -o /dev/null -w '%{http_code}' localhost:8080/readyz` → `503`. Then `curl -s -o /dev/null -w '%{http_code}' localhost:8080/healthz` → `200`. Then `docker compose start db` and wait for `/readyz` → `200`.
- **Do not:** leak exception text in 500 bodies, log request bodies, or add GZip.

### WP-07 Endpoints T0 + T1 (tier M), depends on WP-04, WP-06
- **Files:** `app/repositories/*.py` (including the `errors.py` SQLSTATE/constraint map from §5), `app/services/{availability.py, booking.py, patients.py}`, `app/schemas/*.py`, `app/api/deps.py` (Clock and session dependencies), `app/api/routers/{doctors.py, patients.py, appointments.py}`, the integration tests for §6 rows 5-13, and `tests/integration/test_error_logging.py`.
- **Write `test_constraint_name_path` first.** It pins the asyncpg attribute path for `sqlstate` and `constraint_name`.
- **Availability** reads booked starts with `starts_at >= :day_start_utc AND starts_at < :next_day_start_utc`, using the clinic-local day bounds. Test: `test_availability_uses_local_day_bounds`.
- **`test_error_logging.py`:** forces a `ck_appt_cancel_consistency` violation through the service path, captures the logs, and asserts that neither the reason string nor the patient id appears in them.
- **Acceptance:**
  - `uv run pytest tests/integration -q` → all passed. There is at least one test per non-T2 error cell in §6 rows 5-13, each asserting status, `Content-Type: application/problem+json` and `code`.
  - **Manual check.** Use the first date D where `GET /doctors/<otieno>/availability?date=D` returns ≥ 1 slot, and book `slots[0].starts_at`. Expect 201, then 409 `SLOT_TAKEN` on repeat, 200 on cancel, and 201 on rebook. Check each step with `jq -r .code` / the status.
  - `curl -sI ".../availability?date=<D>" | rg -i cache-control` → `no-store`.
- **Do not:** add a slot-taken pre-SELECT, open transactions in routers, return 400 anywhere, or use SQL `now()` in business queries.

### WP-08 Concurrency race suite + naive control (tier M), depends on WP-07
- **Files:** `tests/concurrency/*.py` (cases 1-4, 7, 8 and the control; case 5 is added by WP-14), `pytest.ini` markers `race` and `control`, Makefile targets `test-race` and `test-control`.
- **Harness:**
  - `asyncio.Barrier(n)`, then `asyncio.gather`. One request per task over `httpx.AsyncClient(transport=ASGITransport(app))`, with `DB_POOL_SIZE=30`.
  - A test-only dependency override adds a `pg_sleep(0.2)` hook after the write and before commit.
  - A lock sampler task polls `pg_locks` (§3.4).
- **Cases** (counts are asserted in the test, not printed):

| Case | Assertion |
|---|---|
| 1. 25 POSTs, same slot, distinct patients, 10 iterations | 1×201, 24×409 `SLOT_TAKEN`, booked rows = 1, peak waiters ≥ 5 |
| 2. Same patient, two doctors, same time | 1×201, 1×409 `PATIENT_DOUBLE_BOOKED` |
| 3. Two reschedules into one free slot | 1×200, 1×409; the loser keeps its original slot |
| 4. Cancel vs reschedule of the same appointment | final state consistent; the events match the final state |
| 7. Swap: A 09:00→10:00 ∥ B 10:00→09:00 | no 5xx; the final state is the original or the swap; any 409 is `SLOT_TAKEN` or `CONCURRENT_UPDATE` |
| 8. Cancel X at S ∥ reschedule Y into S | never two booked rows at S; no 5xx |
| Control (`clinic_control` DB, index dropped, `NaiveBookingService` with `pg_sleep(0.1)` between SELECT and INSERT) | booked rows > 1 |

- **Acceptance:**
  - `uv run pytest -m race -rA -q` → passed.
  - `uv run pytest -m control -rA -q` → passed.
  - Both run 3 times in a row with no flakes.
- **Do not:** share one AsyncSession across tasks, wrap race tests in a rollback fixture, or let `NaiveBookingService` exist outside `tests/`.

### WP-09 Contract tests + OpenAPI export (tier M), depends on WP-07 (parallel with WP-08)
- **Files:** `tests/contract/test_schemathesis.py`, `backend/scripts/export_openapi.py`, `contracts/openapi.json`, `responses=` on all routes.
- **`export_openapi.py`** builds the app with a **fixed** `Settings(PUBLIC_BASE_URL="https://api.example", WEB_ORIGIN="http://localhost:3000", DATABASE_URL="postgresql+asyncpg://x@localhost/x")`, independent of the environment. It writes sorted keys and does not connect to the DB.
- **Schemathesis:** `schemathesis.openapi.from_asgi("/openapi.json", app)` with `@schema.parametrize()` and `case.call_and_validate()`. Checks: not_a_server_error, status_code_conformance, response_schema_conformance.
- **Acceptance:**
  - `uv run pytest tests/contract -q` → passed.
  - `make openapi && git diff --exit-code contracts/` → exit 0 on a second run.
  - `DATABASE_URL=bogus make openapi && git diff --exit-code contracts/` → exit 0.
  - **Lean-core freshness (§12.4):** `backend-quality` runs `make openapi && git diff --exit-code contracts/openapi.json`, so the committed contract always matches the code at that commit. The public `/openapi.json` is built from that file, so this check, not the T2 `contract-drift` job, is what keeps the public spec honest when WP-15 is cut.
  - `uv run pytest --cov=app --cov-fail-under=85 -q` → passed.
- **Do not:** relax checks to get a pass. Any 5xx found is a bug to fix.

### WP-10 CircleCI verify workflow (tier M), depends on WP-03; grows with WP-08/09/13
- **Files:** `.circleci/config.yml`.
- **Jobs:**
  - `backend-quality`: ruff, mypy, `scripts/migration_lint.sh`.
  - `backend-test`: cimg/python:3.12 plus a `cimg/postgres:17.x` secondary image (tag from WP-00). It creates `clinic_app` from `01-roles.sql`, then runs unit, integration, migrations, race and control, with JUnit and coverage artifacts.
  - `backend-contract`.
  - `secrets`: gitleaks full history.
- **Workflow `pr`:**
  ```yaml
  when:
    and:
      - not: { equal: [ main, << pipeline.git.branch >> ] }
      - not: << pipeline.git.tag >>
  ```
- **Workflow `release`:** `when: { and: [ { equal: [ main, << pipeline.git.branch >> ] }, { not: << pipeline.git.tag >> } ] }`. It runs the same verify jobs. The deploy jobs are added in WP-11/12.
- **uv install:** `pip install uv==<WP-00 version>`, then `uv sync --frozen`. Not the python orb.
- **Acceptance:**
  - `circleci config validate` → `Config file at .circleci/config.yml is valid.`
  - A PR shows a green CircleCI status on GitHub, and the pipeline URL is in the PR body.
  - After the first week of PRs, record credit usage from the CircleCI plan page in `docs/versions.md`.
  - **Credit budget ($0 audit, ADR-0016):** monthly target ≤ 22,200 credits worst case (30,000 free, no card). Resource classes as listed in ADR-0016 (`small` for lint-class jobs, `medium` otherwise, never `large` or Gen2); no `docker_layer_caching`; `restore_cache`/`save_cache` keyed on `uv.lock`, `pnpm-lock.yaml`, `go.sum` and the Trivy DB by date; web and realtime jobs self-skip with `circleci-agent step halt` when `git diff --name-only origin/main...HEAD` shows none of their paths (`web/`, `contracts/` for web, which since §12.3 also covers the proxy; `services/realtime/`, `backend/migrations/`, `contracts/events/` for realtime), so required checks still report; `release` never skips. Docker Official Images come from `mirror.gcr.io/library/...` pinned by digest; `cimg/*` images come from `mirror.gcr.io/cimg/*` ~~with `auth:` from the `dockerhub-ro` context~~ with no Docker Hub login (engineer, 2026-10-16).
  - `rg -n 'docker_layer_caching: *true|resource_class: *(large|xlarge|2xlarge|.*gen2)' .circleci/config.yml` → no output (also enforced by `cost-static`).
  - After WP-10, Plan → Usage shows the per-pipeline credits of one PR pipeline; record it in `docs/versions.md` and recompute §13.3 if a PR pipeline exceeds 500 credits.
  - Plan → Usage Controls: artifact, cache and workspace retention set to the minimum, screenshot in `docs/runbooks/bootstrap-gcp.md`.
- **Do not:** store secrets in the project settings.

### WP-11 GCP + Neon foundation and walking-skeleton deploy (tier M drafts, tier E applies), starts D1, depends on WP-03, WP-10 and answers Q1-Q3, Q5, Q6
- **Part A (D1): files.** `infra/bootstrap.sh`, `infra/terraform/*.tf`, `docs/runbooks/{bootstrap-gcp.md, neon.md}`.
- **`bootstrap.sh`, run once by the engineer.** It does not use the placeholder variable names in the repo.
  1. Create the state bucket `gs://clinic-tfstate-<project>` (~~europe-west3~~ **us-east1**, versioned; amended by the $0 audit because Cloud Storage Always Free applies only in us-west1, us-central1 and us-east1): `gcloud storage buckets create gs://clinic-tfstate-<project> --location=us-east1 --default-storage-class=STANDARD --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0` (flag confirmed in WP-00 (e)), then `gcloud storage buckets update gs://clinic-tfstate-<project> --versioning` and a lifecycle rule that deletes noncurrent versions beyond the newest 5 (`{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"numNewerVersions":5}}]}`). The state holds no secret values (secret containers only, no versions), so its US location carries no residency issue.
  2. **Create the Cloud Run service once** with `gcloud run deploy clinic-api --image us-docker.pkg.dev/cloudrun/container/hello --region us-east4 --no-allow-unauthenticated --min-instances 0 --max-instances 3 --add-custom-audiences=clinic-api` (region amended from europe-west3 by the $0 audit).
  3. ~~Grant public access with `gcloud run services add-iam-policy-binding clinic-api --region europe-west3 --member=allUsers --role=roles/run.invoker`.~~ **Amended by the $0 audit (ADR-0023): no `allUsers` binding.** Grant invoker to the two service identities only, after Terraform has created them: `gcloud run services add-iam-policy-binding clinic-api --region us-east4 --member=serviceAccount:clinic-web@<project>.iam.gserviceaccount.com --role=roles/run.invoker` (the web project's proxy identity, §12.3), and the same for `clinic-smoke@<project>.iam.gserviceaccount.com`.
  4. **Budgets ($0 audit; the spend cap is console/Budget API unless WP-00 (c) shows Terraform supports it):** a Cloud Run spend-cap budget scoped to this project and the Cloud Run service (`152E-C115-5142`), monthly, $3 **gross**, which pauses new Cloud Run usage on trigger. It reads gross cost before the free-tier discount, so it trips before gross compute reaches the $4.32 Tier 1 CPU discount; enforcement "isn't instant", and the $1.32 between cap and discount is the margin for that delay (deduced). Record the budget id in `docs/runbooks/bootstrap-gcp.md`.

  CI therefore never needs `setIamPolicy`, and it never passes `--allow-unauthenticated`.
- **Terraform scope:**
  - APIs: run, artifactregistry, secretmanager, iam, iamcredentials, sts, billingbudgets, monitoring (for the alert policy). **Never** containerscanning, ondemandscanning or cloudbuild ($0 audit: Artifact Analysis bills $0.26 per scanned image with no free tier; Cloud Build creates extra buckets and repos outside the free regions).
  - Artifact Registry repo `clinic` (~~europe-west3~~ **us-east4**) with ~~a keep-last-5 cleanup policy~~ cleanup policies (amended by the $0 audit; 0.5 GiB free per billing account): `keep-2` (action KEEP, `mostRecentVersions.keepCount = 2`), `delete-untagged` (action DELETE, `tagState = UNTAGGED`), `delete-old` (action DELETE, `olderThan = 7d`; KEEP wins over DELETE). Image-count target: **≤ 2 versions per package, repository `sizeBytes` < 400,000,000.** Cleanup runs about daily, so `ship-api` also prunes right after promotion (WP-12).
  - Service accounts `circleci-deployer`, `clinic-api-runtime`, `clinic-migrate`, and ($0 audit, ADR-0023) `clinic-web` (the web project's proxy identity; called `clinic-frontdoor` in the superseded two-project draft, §12.3) and `clinic-smoke` (moved from S3 into the lean core).
  - WIF pool `vercel` with OIDC provider `vercel` (`wif_vercel.tf`): issuer `https://oidc.vercel.com/<team>`, `allowed_audiences = ["https://vercel.com/<team>"]`, `google.subject = assertion.sub`, `attribute_condition = "assertion.sub == 'owner:<team>:project:clinic-web:environment:production'"`. The principal ~~`principal://iam.googleapis.com/<pool>/subject/owner:<team>:project:clinic-web:environment:production`~~ (written in full by §12.4) `principal://iam.googleapis.com/projects/<NUMBER>/locations/global/workloadIdentityPools/vercel/subject/owner:<team>:project:clinic-web:environment:production` gets `roles/iam.serviceAccountOpenIdTokenCreator` on `clinic-web` only (direct federated call to `generateIdToken`; unverified). Fallback, if that call is denied: grant `roles/iam.workloadIdentityUser` on `clinic-web` to the same principal and make the **same single call**; `workloadIdentityUser` is a superset that includes `iam.serviceAccounts.getOpenIdToken` (observed by the hosting lock review with `gcloud iam roles describe roles/iam.workloadIdentityUser`, 2026-10-16). ~~followed by impersonation~~: there is no second hop (a `generateAccessToken` then `generateIdToken` chain would also need `clinic-web` to hold token-creator on itself, which nobody grants). If both fail, K38.
  - Monitoring (`monitoring.tf`): one email notification channel and one alert policy on Cloud Run sent bytes summed per day across the project, threshold 30,000,000 bytes (a 1 GiB month is about 34.6 MB a day). Alerting is free until at least 2027-09-01 (cloud.google.com/stackdriver/pricing, read by the audit); from then it is $0.35 per metric reference a month (verified by the cost verifier), so the policy and its channel are deleted, or the §13 proof is re-run, before 2027-08-01 (§13.6 dated obligations). No uptime checks.
  - Logging (`logging.tf`): one exclusion on the `_Default` sink, ~~`drop-iam-403`, filter `... AND httpRequest.status=403`~~ (widened by §12.4) `drop-iam-denied`, filter `resource.type="cloud_run_revision" AND logName:"run.googleapis.com%2Frequests" AND (httpRequest.status=401 OR httpRequest.status=403)`. Cloud Run answers 401 for a junk, malformed, multiple or wrong-audience bearer and 403 for a missing or unauthorised token (docs.cloud.google.com/run/docs/troubleshooting, last updated 2026-10-13, read 2026-10-16), so a 403-only filter left the log path open to anyone who adds one header. IAM-denied requests are free on Cloud Run (verified for denials; that the 401 variant is also unbilled is deduced) but still write request logs (deduced), and ingestion past 50 GiB per project a month bills $0.50/GiB (verified); excluded logs are not ingested and exclusions are free (cost verifier, 2026-10-16). The `logName` clause keeps the app's own stdout logs, so a stretch S3 401 `ADMIN_AUTH_REQUIRED` or 403 `ADMIN_FORBIDDEN`, and a gateway 401 `STREAM_TICKET_REQUIRED`, are still logged by the app; only their platform request-log lines are dropped (accepted). Fallback command: `gcloud logging sinks update _Default --add-exclusion=name=drop-iam-denied,filter='<the filter above>' --project <p>`.
  - IAM:
    - Deployer: `roles/run.developer` (project), `roles/artifactregistry.writer` (repo), `roles/iam.serviceAccountUser` on the runtime and migrate SAs.
    - Deployer, added by the $0 audit for `cost-check` (read-only metadata, no secret payloads): `roles/secretmanager.viewer` and `roles/serviceusage.serviceUsageViewer` (project); `roles/iam.serviceAccountTokenCreator` on `clinic-smoke` only (smoke tokens). `roles/artifactregistry.writer` already covers listing and deleting versions for the prune.
    - `clinic-api-runtime`: `secretAccessor` on `clinic-database-url-app` only.
    - `clinic-migrate`: `secretAccessor` on `clinic-database-url-migrate` only.
  - WIF (ADR-0016):
    ```hcl
    resource "google_iam_workload_identity_pool_provider" "circleci" {
      workload_identity_pool_id          = google_iam_workload_identity_pool.circleci.workload_identity_pool_id
      workload_identity_pool_provider_id = "circleci-oidc"
      attribute_mapping = {
        "google.subject"       = "assertion['oidc.circleci.com/project-id'] + ':' + assertion['oidc.circleci.com/vcs-ref']"
        "attribute.project_id" = "assertion['oidc.circleci.com/project-id']"
      }
      attribute_condition = "assertion['oidc.circleci.com/project-id'] == '${var.circleci_project_id}' && assertion['oidc.circleci.com/vcs-ref'] == 'refs/heads/main'"
      oidc {
        issuer_uri        = "https://oidc.circleci.com/org/${var.circleci_org_id}"
        allowed_audiences = [var.circleci_org_id]
      }
    }
    ```
    - `google.subject` must stay under 127 bytes. A project UUID plus `:refs/heads/main` is about 52 bytes. **Never map `assertion.sub`**, which runs to 160 bytes or more.
    - The deployer SA's `roles/iam.workloadIdentityUser` is bound to `principalSet://iam.googleapis.com/${pool.name}/attribute.project_id/${var.circleci_project_id}`. The main-only restriction lives in `attribute_condition`.
    - **Fallback if WP-00 finds there is no `vcs-ref` claim:** set `google.subject = assertion['oidc.circleci.com/project-id']` and condition on `assertion.sub.endsWith('/vcs-ref/refs/heads/main')`.
  - Secret containers `clinic-database-url-app` and `clinic-database-url-migrate`, with no versions in Terraform.
  - Budget: $1 with alerts at 50/90/100%. **This alerts only; it does not cap spend** (cloud.google.com/billing/docs/how-to/budgets). Scope it to the billing account, not just this project, so usage by any other project sharing the free tiers shows up. The caps are the spend-cap budget (bootstrap step 4), max-instances, IAM gating and the plan limits listed in §13.5.
- **Neon runbook:**
  1. `neonctl projects create --help` first. The flags are **unverified**.
  2. Create the project in ~~aws-eu-central-1~~ **aws-us-east-1** (amended by the $0 audit, beside Cloud Run us-east4) on PG 17, with database `clinic` and owner role `clinic_owner`. Set the compute to a fixed 0.25 CU (autoscaling min = max = 0.25) and leave scale-to-zero on (it cannot be disabled on Free). No card is added.
  3. As `clinic_owner`, run `CREATE ROLE clinic_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;`. The password comes from `openssl rand -base64 32` and is never echoed. The role is created in SQL, not via the console, so it does not inherit `neon_superuser` (**unverified**; acceptance checks it).
  4. Record `SHOW max_connections` and `SELECT name FROM pg_available_extensions WHERE name='btree_gist'` in ADR-0003 and ADR-0014.
  5. Add each URL with `printf %s "$URL" | gcloud secrets versions add <secret> --data-file=-`. Use the direct (non-pooler) host and `?ssl=require` only.
  6. **Rotation ($0 audit):** a password rotation adds the new version, redeploys, then **destroys** (not disables) the old one: `gcloud secrets versions destroy <old> --secret=<secret>`. Disabled versions still count as active and are billed past 6.
- **Part A acceptance:**
  - The plan grep (global rule 8) finds nothing.
  - `gcloud iam workload-identity-pools providers describe circleci-oidc --location=global --workload-identity-pool=circleci --project <p> --format=json | jq -r '.attributeMapping["google.subject"]'` does not contain `assertion.sub`.
  - `... | jq -r '.oidc.allowedAudiences[0]'` equals the org id.
  - `gcloud secrets versions list clinic-database-url-app --format=json | jq length` → `1`. The same holds for `-migrate`.
  - As `clinic_app` on Neon, `CREATE TABLE x(i int)` → permission denied.
  - Cost-control checks C1-C6, C9, C10 and C13 in "Cost-control acceptance checks" below pass.
- **Part B (by end of D2), walking skeleton.**
  - Add release jobs `build-scan-push` and `ship-api` (ADR-0016 shape) **without** migrate and with smoke limited to `/healthz`, then merge.
  - CircleCI contexts:
    - `gcp-deploy`: identifiers only (GOOGLE_PROJECT_ID, GOOGLE_PROJECT_NUMBER, DEPLOYER_SA, WEB_ORIGIN, PUBLIC_BASE_URL), with an expression restriction `pipeline.git.branch == "main"`.
    - `oidc-probe`: empty and unrestricted.
- **Part B acceptance:**
  - The main pipeline is green, and ~~`curl ... https://<prod>/healthz`~~ (placeholder fixed by §12.4) `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/healthz"` → `200` from a machine with no gcloud auth (needs Part C live; §6 defines `$PUBLIC_API`); `curl -s -o /dev/null -w '%{http_code}' https://clinic-api-<hash>.us-east4.run.app/healthz` → `403`.
  - **WIF negative test:** branch `test/wif-deny` with a temporary job that uses context `oidc-probe` and attempts the OIDC exchange → permission denied.
  - **Context negative test:** the same branch with a job attaching `gcp-deploy` → an unauthorized-context failure.
  - Save both log URLs in `docs/runbooks/bootstrap-gcp.md`, then delete the branch.
- **Fallback:** if Terraform is not applied by D2 12:00, put the equivalent `gcloud` commands into `infra/bootstrap.sh`, remove `infra/terraform/` from the plan and note it in the README. The fallback keeps the state-free cost guards: the cleanup policy (`gcloud artifacts repositories set-cleanup-policies`), budgets, alert policy, log exclusion and Vercel WIF pool become `gcloud` steps, and with no Terraform there is no state bucket at all.
- **Part C0 (D1-D2, tier E), Vercel bootstrap (added by the hosting lock review, §12.4).** Without it `vercel pull --yes` in CI either fails as unlinked or links a project named after the directory (`web`), whose OIDC `sub` would read `project:web` and fail the WIF condition. Steps, run once by the engineer from a laptop with the Vercel CLI logged in:
  1. `vercel project add clinic-web --scope <team>`.
  2. Dashboard → `clinic-web` → Settings → Security → OIDC Federation: confirm issuer mode **Team** (issuer `https://oidc.vercel.com/<team>`, per vercel.com/docs/oidc/reference, last updated 2026-09-17, read 2026-10-16).
  3. Settings → General → Root Directory: **leave empty**, because CI passes `--cwd web` (a Root Directory of `web` plus `--cwd web` would resolve to `web/web`).
  4. `cd web && vercel link --yes --project clinic-web --scope <team>`, then read `orgId` and `projectId` from the generated `web/.vercel/project.json` (gitignored; identifiers, not secrets) and add them to the CircleCI context `vercel-prod` as `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, beside `VERCEL_TOKEN` (ADR-0016). With both set, the CLI uses that project and never links or creates one.
  5. For each name in §7 "`web` proxy config": `vercel env add <NAME> production --cwd web` (values are identifiers only).
  - **Acceptance:** `vercel env ls production --cwd web` lists every §7 proxy name; `vercel project ls --scope <team>` shows `clinic-web` and no project named `web`; after Part C's first deploy, `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/healthz"` → `200`, which shows STS accepted the token, because the WIF condition admits only `sub == owner:<team>:project:clinic-web:environment:production`. **Negative test:** create a throwaway project `clinic-wif-probe`, `vercel env pull` its development OIDC token (if WP-00 (f) shows `env pull` provides one), and POST it to STS with the Part C exchange request → `400`/`403` with an attribute-condition error; decode only the claims (`cut -d. -f2 | base64 -d`) to record `sub` in `docs/runbooks/bootstrap-gcp.md`; then delete the probe project. No token is ever logged or committed.
- **Part C (by end of D2), the lean-core `web/` project: the front door and the landing page ($0 audit, ADR-0023; one Vercel project by the engineer's decision, §12.3; lean core, tier M, Vercel project tier E).** Never cut: it is the public URL, and it is live for Gate A and therefore in place for Gate B. The superseded two-project draft built this as a separate `frontdoor/` project with its own jobs `frontdoor-quality` and `ship-frontdoor` (§12.3).
  - **Files:** the lean-core part of `web/**` (§7): `package.json` (next 16.4.2, react 19.3.1, react-dom, `@vercel/oidc` at the version resolved here and written to `docs/versions.md`; typescript, eslint and vitest as dev dependencies), `next.config.ts` (`images: { unoptimized: true }`, no rewrites), `tsconfig.json`, `vercel.json` (`{"git":{"deploymentEnabled":false},"regions":["iad1"]}`), `src/app/layout.tsx` and `src/app/page.tsx` (a static landing page: one paragraph and links to `/docs`, `/redoc`, `/openapi.json` and `/api/healthz`; no client JS), the proxy route handlers, `src/lib/proxy/**`, `tests/proxy/**`; root `pnpm-workspace.yaml` (`packages: [web]`, moved here from WP-15); CircleCI jobs `web-quality` (`pnpm install --frozen-lockfile`, eslint, `tsc --noEmit`, vitest, `next build`; self-skips when `web/` and `contracts/` are untouched) and `ship-web` (release, after `ship-api`, context `vercel-prod` holding `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from Part C0: `vercel pull --yes --environment=production --cwd web && vercel build --prod --cwd web && vercel deploy --prebuilt --prod --cwd web`; it halts with `circleci-agent step halt` unless `ship-api` persisted a `promoted` marker to the workspace, so the web build never ships a contract newer than the live API), and `smoke-public` (release, after `ship-web`, no context, `small`; the curl checks under Acceptance below; WP-12 adds `verify_claims.py`). Both jobs move here from WP-15 and WP-16, which only extend them. **Added by §12.4:** `web/scripts/snapshot-openapi.mjs` runs as `prebuild`: it reads `../contracts/openapi.json` (kept fresh by WP-09's lean-core check), replaces `servers` with `[{"url":"/api"}]` and writes `src/generated/openapi.public.json`.
  - **Routes:** `src/app/api/[...path]/route.ts` (`runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 300`) strips the `/api` prefix and forwards the rest unchanged: `/api/stream` → `REALTIME_URL` + `/stream` (S1 only), everything else → `API_URL`. ~~`src/app/docs/route.ts`, `src/app/redoc/route.ts` and `src/app/openapi.json/route.ts` (GET and HEAD only) forward to the same path on `clinic-api`; ... all three set `Cache-Control: public, s-maxage=600, stale-while-revalidate=600`~~ (superseded by §12.4: Vercel's CDN cache key includes the query string, deduced, so `/openapi.json?x=<random>` would miss on every request and fetch the spec from Cloud Run each time). `src/app/docs/route.ts`, `src/app/redoc/route.ts` and `src/app/openapi.json/route.ts` set `export const dynamic = "force-static"` and import nothing from `src/lib/proxy/`: `/openapi.json` returns the build-time snapshot (with `servers: [{"url":"/api"}]`, so Swagger's "Try it out" goes through the proxy), `/docs` and `/redoc` return fixed HTML that loads `swagger-ui-dist` and `redoc` from jsdelivr at exact versions recorded in `docs/versions.md` (the same CDN FastAPI's default pages use) and point at `/openapi.json`. `next build` prerenders them, so no request to them ever reaches Cloud Run, whatever its query string. In the catch-all, `/api/docs`, `/api/redoc` and `/api/openapi.json` answer `308` to the root routes and are never forwarded. Nothing else may live under `src/app/api/`: S3's Auth.js uses `basePath: "/auth"` and S4's route is `/ui/appointments`.
  - **Token exchange (exact calls, §12.4; ADR-0023):** inside the request handler, never at module level, `subject = await getVercelOidcToken()` (not cached). (1) `POST https://sts.googleapis.com/v1/token`, form-encoded: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `audience=//iam.googleapis.com/projects/$GCP_PROJECT_NUMBER/locations/global/workloadIdentityPools/vercel/providers/vercel`, `scope=https://www.googleapis.com/auth/cloud-platform`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, `subject_token_type=urn:ietf:params:oauth:token-type:jwt`, `subject_token=<subject>`. (2) `POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$GCP_SERVICE_ACCOUNT_EMAIL:generateIdToken` with `Authorization: Bearer <STS access_token>` and body `{"audience":"clinic-api","includeEmail":true}` (or `clinic-realtime`). Only the resulting Google ID token is cached (module scope, per audience, until 5 minutes before its `exp`); the Vercel OIDC token and the STS token are never cached or logged. Vercel's own GCP guide documents only the impersonation path (`generateAccessToken`); our direct federated `generateIdToken` is unverified until this Part's acceptance passes (K38), with the single-call fallback in the Terraform scope above.
  - **Behaviour (proxy):** as ADR-0023: path after `/api` and query passed through; ID token from the exchange above (audience `clinic-api` / `clinic-realtime`), sent as `X-Serverless-Authorization`; client `Authorization` forwarded unchanged; client-sent `X-Serverless-Authorization` and `X-Client-IP` dropped; request headers `host`, `connection`, `content-length`, `keep-alive`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding` and `upgrade` dropped (Cloud Run routes on `Host`, and `fetch` sets its own); response headers `content-encoding`, `content-length` and `transfer-encoding` dropped (Node `fetch` decompresses the upstream body, so copying them would corrupt it); a `Location` that starts with `/` is rewritten to `/api` + value (§6); `X-Client-IP` set from Vercel's client-IP header (WP-00 (f)); response streamed, never buffered; methods GET/HEAD/POST/PATCH/OPTIONS; body > 64 KB → 413; per-IP 120/min per instance → 429 with `Retry-After`. `call-api.ts` exposes the same forwarding to server routes in-process (S3, S4). With `VERCEL_ENV` unset (local), no ID token is minted and requests go to `API_URL` as given.
  - **Tests:** `pnpm -C web test tests/proxy` → passed: forwards method, path, query, body and the `Idempotency-Key`, `X-Request-ID`, `Authorization` headers; strips client `X-Serverless-Authorization` and overwrites `X-Client-IP`; never forwards `host` or the hop-by-hop set; routes `/api/stream` to the realtime URL; returns upstream status, headers (`Idempotent-Replayed`, `Retry-After`) and body unchanged, ~~`Location` unchanged~~ except that `location.test.ts` asserts `Location: /appointments/x` → `/api/appointments/x` and an absolute `Location` is left alone; an upstream gzip response (`content-encoding: gzip`) reaches the client as a valid, parseable body with no `content-encoding` header; the token cache refreshes 5 minutes before `exp`, and `getVercelOidcToken` is called once per mint, never at import. `docs-routes.test.ts`: `/openapi.json` comes back with `servers[0].url == "/api"`, ~~and `s-maxage=600`~~ each doc route module exports `dynamic = "force-static"`, and with a mocked global `fetch`, GET `/openapi.json?x=<random>`, `/docs?x=<random>` and `/redoc` make **zero** upstream calls; `/api/openapi.json`, `/api/docs` and `/api/redoc` through the catch-all → `308` with no upstream call; the `/docs` HTML references `/openapi.json`; `route-layout.test.ts`: the only `route.ts` under `src/app/api/` is `[...path]/route.ts`.
  - **Acceptance:**
    - `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/healthz"` → `200`, and `curl -s -o /dev/null -w '%{http_code}' https://clinic-api-<hash>.us-east4.run.app/healthz` → `403`, both from a machine with no credentials.
    - `curl -s "$WEB/openapi.json" | jq -r '.info.title, .servers[0].url'` → the API title and `/api`; `$WEB/docs` renders Swagger and "Try it out" works on ~~`GET /doctors`~~ `GET /healthz` (request URL `$PUBLIC_API/healthz`, response 200). The `GET /doctors` check moves to WP-12, because the prod schema and seed arrive with WP-12's first migrate (§12.4).
    - ~~A second `curl -sI https://<web>/openapi.json` within 10 minutes of the first shows `x-vercel-cache: HIT`.~~ (superseded by §12.4) The `next build` route table in the `ship-web` log marks `/docs`, `/redoc` and `/openapi.json` as static (`○`), and after `for i in 1 2 3; do curl -s -o /dev/null "$WEB/openapi.json?x=$RANDOM"; done`, `gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl:"/openapi.json"' --freshness=10m --project <p> --format=json | jq length` → `0`.
    - `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/openapi.json"` → `308`.
    - `curl -s "$WEB/" | rg -c 'href="/docs"'` → `1` or more (the landing page links Swagger).
    - **Exchange negative:** Part C0's probe-project token is rejected by STS.
    - `smoke-public` is green on the release that deployed this Part: `curl -fsS "$PUBLIC_API/healthz"`, `curl -fsS "$WEB/openapi.json" | jq -e '.servers[0].url=="/api"'`, `curl -fsS -o /dev/null "$WEB/docs"`, and the run.app `/healthz` → `403`.
    - `gcloud run services get-iam-policy clinic-api --region us-east4 --format=json | jq -r '.bindings[]|select(.role=="roles/run.invoker")|.members[]' | sort` → exactly `serviceAccount:clinic-smoke@…` and `serviceAccount:clinic-web@…`.
    - The Vercel deployment summary shows functions in `iad1` only, and the team has exactly one project for this system, `clinic-web`.
  - **If Vercel OIDC cannot mint an ID token by Gate A**, the engineer chooses (Q5): fall back to ADR-0023 option 2 (re-add `allUsers`, record Africa egress in §13 as a breach) or hold Gate A. The executor never makes that call.
- **Do not:** put secret values in tfvars or state, let Terraform manage the Cloud Run service, or give the deployer SA `run.admin`.

### WP-12 Release pipeline complete: migrate, tagged deploy, smoke, promote-by-tag (tier M), depends on WP-08, WP-09, WP-11
- **Precondition (§12.4):** WP-00 (i) is settled (same-region Artifact Registry pulls carry no network charge), or the fallback written there applies.
- **Files:** `scripts/verify_claims.py`, the `.circleci/config.yml` `ship-api` job and the `verify_claims.py` step of `smoke-public`, `scripts/migration_lint.sh`, `docs/runbooks/rollback.md`, README §1 URL fill-in.
- **`ship-api` steps** (one job, `serial-group: << pipeline.project.slug >>/deploy-prod`, context `gcp-deploy`):
  1. OIDC → WIF login (ADR-0016 snippet).
  **Region amended by the $0 audit:** every `--region` in this job is `us-east4` (it read europe-west3 before; the commands below are the amended ones).
  2. `gcloud run jobs deploy clinic-migrate --image "$IMAGE@$DIGEST" --region us-east4 --service-account clinic-migrate@$GOOGLE_PROJECT_ID.iam.gserviceaccount.com --set-secrets DATABASE_URL=clinic-database-url-migrate:latest --task-timeout 600s --max-retries 0 --command sh --args="-c,alembic upgrade head && python -m app.scripts.seed"`, then `gcloud run jobs execute clinic-migrate --region us-east4 --wait`. (`--task-timeout` and `--max-retries 0` added by the $0 audit, so a hung migration cannot keep billing.)
  3. `gcloud run deploy clinic-api --image "$IMAGE@$DIGEST" --region us-east4 --no-traffic --tag "sha-${CIRCLE_SHA1:0:7}" --service-account clinic-api-runtime@$GOOGLE_PROJECT_ID.iam.gserviceaccount.com --set-secrets DATABASE_URL=clinic-database-url-app:latest --set-env-vars GIT_SHA=$CIRCLE_SHA1,PUBLIC_BASE_URL=$PUBLIC_BASE_URL,WEB_ORIGIN=$WEB_ORIGIN --min-instances 0 --max-instances 3 --concurrency 80 --cpu 1 --memory 512Mi --cpu-boost --timeout 60 --add-custom-audiences=clinic-api --quiet`.
  4. Resolve the tag URL: `gcloud run services describe clinic-api --region us-east4 --format=json | jq -r '.status.traffic[]|select(.tag=="sha-'"${CIRCLE_SHA1:0:7}"'")|.url'`.
  5. **C19 gate (§12.4; a gate, not a record):** `test "$(curl -s --max-time 5 https://ipinfo.io/country)" = US || { echo 'FAIL C19: CircleCI egress outside North America; tag-URL smoke skipped, nothing promoted'; exit 1; }`. CircleCI documents its job machines in US regions only (WP-00 (l)), so this is expected to pass; if it ever fails, no byte is requested from the tag URL, the release stops before promotion and the engineer decides (Q20). Then run `python scripts/verify_claims.py --base-url "$TAG_URL" --header "X-Serverless-Authorization: Bearer $(gcloud auth print-identity-token --impersonate-service-account=clinic-smoke@$GOOGLE_PROJECT_ID.iam.gserviceaccount.com --audiences=clinic-api)"` (the service is IAM-gated; $0 audit). If WP-00 (b) shows a custom audience is not accepted on tag URLs, the audience is `$TAG_URL`. The token is never echoed (`set +x` around the step).
  6. `git fetch origin main`. If `$CIRCLE_SHA1 != $(git rev-parse origin/main)`, skip promotion (a newer commit will ship) and do not write the `promoted` workspace marker, so `ship-web` and `smoke-public` halt too (§12.4).
  7. Promote with `gcloud run services update-traffic clinic-api --region us-east4 --to-tags "sha-${CIRCLE_SHA1:0:7}=100"`, then remove tags older than the last ~~3~~ **2** with `--remove-tags` (amended: matches Artifact Registry's 2 versions per package).
  8. **Prune Artifact Registry ($0 audit).** `gcloud artifacts docker images list us-east4-docker.pkg.dev/$GOOGLE_PROJECT_ID/clinic/clinic-api --include-tags --sort-by=~UPDATE_TIME --format=json | jq -r '.[2:][] | .package + "@" + .version'`, then `gcloud artifacts docker images delete <each> --delete-tags --quiet`. The newest 2 stay: the promoted one and the previous one (the rollback target).
  9. Persist the `promoted` marker to the workspace (read by `ship-web`, §12.4).
- **`verify_claims.py`** (httpx; prints a PASS/FAIL table; exits non-zero on any FAIL; repeatable `--header "Name: value"` added by the $0 audit for the CI-only invoker token, never needed by reviewers, who use `$PUBLIC_API`):
  - Creates **its own fresh patients** each run (`POST /patients`, name `verify-claims <utc timestamp> <n>`, no phone).
  - Picks the first active doctor and date within the next 14 clinic-local days whose availability has ≥ 2 slots.
  - Checks: book `slots[0]` → 201 with exact field values; a second patient on the same slot → 409 `SLOT_TAKEN`; the slot is gone from availability; a naive datetime → 422 `TIMEZONE_REQUIRED`; a past slot → 422 `SLOT_IN_PAST`; an off-hours time → 422 `OUTSIDE_WORKING_HOURS`; reschedule to `slots[1]` → 200 with the old slot back in availability; the upcoming list is sorted and contains it; cancel → 200; cancel again → 409 `APPOINTMENT_ALREADY_CANCELLED`; reschedule after cancel → 409; an unknown appointment → 404 problem+json; `/openapi.json` title (fetched with `follow_redirects=True`, because `$PUBLIC_API/openapi.json` answers 308 to `$WEB/openapi.json`, §6 row 14). **Added by §12.4:** every 201 carries a `Location`, and `GET urljoin(base, Location)` → 200 with the created id, which fails if the proxy's `Location` rewrite breaks (at `$PUBLIC_API` the header reads `/api/appointments/{id}`; at the tag URL `/appointments/{id}`).
  - A `try/finally` cancels anything still booked.
- **`migration_lint.sh`:** `rg -n -i 'drop (table|column)|rename|alter column .* (set not null|type)' backend/migrations/versions/` fails unless the matching line carries `# contract-ok: <reason>`. It runs in `backend-quality`.
- **Acceptance:**
  - A merge to main → green pipeline.
  - `python scripts/verify_claims.py --base-url "$PUBLIC_API"` run 5 times in a row → all PASS. Afterwards, every smoke patient's upcoming list is empty.
  - **Moved from WP-11 Part C (§12.4):** after the first migrate, `$WEB/docs` "Try it out" on `GET /doctors` (request URL `$PUBLIC_API/doctors`) → 200 with 3 doctors.
  - **`smoke-public` (§12.4, lean core, never cut):** after `ship-web`, with no context and no credentials, `python scripts/verify_claims.py --base-url "$PUBLIC_API"` → all PASS, plus the WP-11 Part C curl checks; a deliberately broken proxy in a throwaway branch (for example the WIF condition project name changed in the Vercel env) turns it red; revert.
  - After a release, `gcloud run services describe clinic-api --region us-east4 --format=json | jq -r '.status.traffic[]|select(.percent==100)|.revisionName'` equals the revision carrying tag `sha-<this commit>`.
  - `/readyz` → 200 on prod. This confirms the asyncpg `ssl=require` URL form.
  - README §10 records a measured cold first request (`curl -w '%{time_total}'` after 20+ minutes idle) and the warm p50 of 20 requests. **Amended:** both measured through the web project's URL (`$PUBLIC_API`, §12.3) from Kenya, plus `Server-Timing` to separate the DB share, so the latency trade-off in ADR-0014 is published as numbers.
  - **One push, one version (cost verifier issue 6):** `gcloud artifacts versions list --package clinic-api --repository clinic --location us-east4 --format=json | jq length`, read before and after one release and before its prune step, differs by exactly `1`, which shows the `--provenance=false --sbom=false` build left no attestation manifests (WP-13).
  - **Spec size (issue 11):** `curl -s "$WEB/openapi.json" | wc -c` recorded in `docs/versions.md`. ~~If it exceeds 60,000 bytes, §13.4 W4 and the egress line are recomputed~~ Since §12.4 the spec is static and costs no Cloud Run egress; the size only feeds Vercel's Fast Data Transfer line. **Largest uncached response (§12.4):** `curl -s "$PUBLIC_API/patients/<id>/appointments?limit=100" | wc -c` for a patient with 100 upcoming bookings (created against a local compose stack, not prod) is recorded; if it exceeds 45,000 bytes, K40 and §13.6 are recomputed with it.
  - Cost-control checks C3-C7 below pass after the first full release, and the Billing report check C17 is screenshotted after 48 hours of traffic (billing data lags).
- **Do not:** pass DB credentials to CircleCI, use `--to-latest`, set min-instances above 0, or claim "branch builds cannot deploy" without the negative-test logs.

### WP-12a Cost guards: `cost-static` and `cost-check` jobs, `make cost-check` (tier M), depends on WP-11, WP-12 ($0 audit)
- **Files:** `scripts/cost_check.sh`, Makefile targets `cost-static` and `cost-check`, `.circleci/config.yml` jobs `cost-static` (pr and release, `small`, no context) and `cost-check` (release, after `ship-api` and `ship-realtime` if present, context `gcp-deploy`, `small`), `docs/runbooks/bootstrap-gcp.md` (the manual checks).
- **`cost_check.sh --static`** (no credentials; exit 1 on any hit, printing each failure):
  - every `gcloud run deploy` line in `.circleci/config.yml` and `infra/bootstrap.sh` has `--max-instances <n>` with n ≤ 3 and `--min-instances 0`; every `gcloud run jobs deploy` has `--task-timeout` and `--max-retries 0`;
  - no `gcloud run deploy --source`, `gcloud builds submit`, `docker_layer_caching: true`, `resource_class: large|xlarge|2xlarge|*gen2*` anywhere in the repo's CI and scripts;
  - `infra/terraform/apis.tf` mentions none of `containerscanning`, `ondemandscanning`, `cloudbuild`; no Terraform resource `google_monitoring_uptime_check_config` or `google_cloud_scheduler_job`; no `location` other than `us-east4` (and `us-east1` for state) in `infra/`;
  - each existing `vercel.json` has `.regions == ["iad1"]` and `.git.deploymentEnabled == false`; if `web/next.config.ts` exists it contains `unoptimized: true`;
  - no `preferredRegion` other than `"iad1"` under `web/src`;
  - no public-access flag (cost verifier issue 2): `rg -n '(^|\s)--allow-unauthenticated|--no-invoker-iam-check|invoker[-_]iam[-_]disabled'` over `.circleci/config.yml`, `infra/` and `scripts/` → no output (`--no-allow-unauthenticated` does not match);
  - no always-on or network-billing flag (issue 3): `rg -n -- '--no-cpu-throttling|--vpc-connector|--network|--subnet|--vpc-egress|--gpu|--min[= ][1-9]'` over the same paths → no output;
  - no manual scaling, YAML replace or worker pool (§12.4): `rg -n -- '--scaling|scalingMode|manualInstanceCount|services replace|worker-pools|worker_pool'` over the same paths → no output;
  - every `docker build` / `docker buildx build` line in `.circleci/config.yml` carries both `--provenance=false` and `--sbom=false` (issue 6);
  - CI never downloads from Artifact Registry (issue 5): `rg -n 'pkg\.dev' .circleci/config.yml scripts/ infra/ | rg -i 'docker pull|trivy image|cache-from'` → no output;
  - the only route file under `web/src/app/api/` is `[...path]/route.ts`;
  - each of `web/src/app/{docs,redoc,openapi.json}/route.ts` contains `force-static` and no import from `lib/proxy` (§12.4).
- **`cost_check.sh --live`** (read-only gcloud and one unauthenticated curl; the same script behind `make cost-check` for the engineer's laptop): C1, C2, C3, C4, C5, C6, C7, C8, C10, C18 from "Cost-control acceptance checks" below, each printed PASS/FAIL, exit 1 on any FAIL. It fails explicitly if **max-instances is unset on any Cloud Run service**, or if **the Artifact Registry repository holds more than 2 versions of any package or more than 400 MB**.
- **Acceptance:**
  - `bash scripts/cost_check.sh --static` → exit 0 on `main`. In a throwaway branch, deleting `--max-instances 3` from `ship-api` → exit 1 with `FAIL max-instances missing: ship-api`; revert. Adding `--no-invoker-iam-check` to `ship-api` → exit 1 with `FAIL public-access flag: ship-api`; revert. Adding `--scaling=1` to `ship-api` → exit 1 with `FAIL manual-scaling flag: ship-api`; revert (§12.4).
  - `make cost-check` → all PASS against prod. Temporarily pushing a third image version (re-tag the current digest is not enough; push a rebuilt image) → `FAIL artifact-registry clinic-api versions=3 > 2` until the prune runs; record the output in the PR.
  - The release pipeline shows `cost-check` green after `ship-api`.
- **Do not:** give the deployer any write role for this job, read secret payloads (`versions access`), or call billing APIs from CI (billing-account roles stay with the engineer).

### WP-13 Security gates (tier S), depends on WP-10; DAST needs WP-07
- **CircleCI jobs:**
  - `sast`: semgrep with `--config p/python --config p/typescript --config p/owasp-top-ten --error --metrics=off` (`--metrics=off` added by the $0 audit; no `SEMGREP_APP_TOKEN`, never `semgrep ci`; if a ruleset demands login, vendor a local copy, WP-00 (h)).
  - `sca`: pip-audit over `uv export --frozen --no-dev --format requirements-txt`, plus `pnpm audit --prod --audit-level high` once web exists.
  - `build-scan-push`: builds with `docker buildx build --provenance=false --sbom=false --load` ($0 audit: no attestation manifests, so one push is one Artifact Registry version and keep-2 / C6 hold), then on PRs runs `trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` and `trivy config infra backend/Dockerfile`; on main it also pushes.
  - `dast`: a machine executor that runs `docker compose up -d --wait`, then `docker run --rm --network <compose_network> -v $PWD/.zap:/zap/wrk ghcr.io/zaproxy/zaproxy@<digest from WP-00> zap-api-scan.py -t http://api:8080/openapi.json -f openapi -c rules.tsv -r zap-report.html`. Exit codes 0 and 2 pass; 1 and 3 fail. It stores `zap-report.html` as an artifact.
- **Files:** `.zap/rules.tsv` (generated with `-g`, then reviewed), `.trivyignore`, `docs/runbooks/base-image-cve.md`.
- **Base-image CVE runbook:** rebuild on the newest `python:3.12-slim` digest. If the CVE is still unfixed, add a dated `.trivyignore` entry with a justification and an expiry. Freeze the base digest at feature freeze.
- **Acceptance:**
  - All security jobs are green on a PR.
  - The `dast` job logs `zap exit=<n>` and passes only on 0 or 2.
- **Cost notes ($0 audit):** the ZAP image is pinned by digest (GHCR public pulls are free); the compose stack's `postgres:17-alpine` and the build's `python:3.12-slim` are pulled from `mirror.gcr.io/library/...` by digest, ~~with `docker login` from the `dockerhub-ro` context as a fallback~~ with no Docker Hub login (engineer, 2026-10-16), so Docker Hub's shared-IP limits cannot fail a release; the Trivy DB cache is keyed by date and kept small. Image scanning stays in CI: the Artifact Analysis API stays disabled.
- **Do not:** use `--exit-code 0` on trivy, or run ZAP against prod.

### WP-14 Idempotency keys (tier M, T2, cut 2nd), depends on WP-12
- **Files:** `migrations/versions/0002_idempotency.py`, booking service changes, `tests/integration/test_idempotency.py`, `tests/concurrency/test_race_idempotency.py` (case 5: 10 POSTs with the same key → 1 row, the same id in every response).
- **Semantics:** as in AM-16. On **any** 23505 during the insert, re-check the key before mapping to a 409.
- **Acceptance:**
  - `uv run pytest tests/integration/test_idempotency.py tests/concurrency/test_race_idempotency.py -q` → passed.
  - The tests cover: replay → same id + `Idempotent-Replayed: true`; replay after cancel → 409 `IDEMPOTENCY_KEY_CONSUMED`; same key with a different slot → 422 `IDEMPOTENCY_KEY_REUSED`.
  - `verify_claims.py` gains an idempotency row.
- **Do not:** create a separate keys table.

### WP-15 Web scaffold + codegen + drift gate (tier M; shadcn component adds are tier S; T2, cut 1st), depends on WP-09
- **Amended by §12.3:** this WP now adds the T2 booking-UI layer to the `web/` project that WP-11 Part C created; the scaffold, `pnpm-workspace.yaml`, `web/vercel.json`, `next.config.ts` and `web-quality` already exist there. Cutting this WP leaves the proxy and landing page untouched.
- **Files:** ~~root `pnpm-workspace.yaml` (`packages: [web]`), the `web/*` scaffold~~ (moved to WP-11 Part C) TanStack Query, zod and shadcn added at the WP-00 versions, `web/openapi-ts.config.ts` (@hey-api/openapi-ts 0.99.0, exact pin; **no** separate client-fetch package), `web/src/api/generated/**`, ~~`web/vercel.json`~~ (exists from Part C), CircleCI job `contract-drift` (self-skips when `web/` and `contracts/` are untouched, ADR-0016; ~~`web-quality`~~ exists from Part C).
- **`web-quality`:** `pnpm install --frozen-lockfile`, eslint, `tsc --noEmit`, vitest, `next build`.
- **`contract-drift`:** `make openapi && pnpm -C web gen:api && git diff --exit-code contracts web/src/api/generated`.
- **Codegen config:** `defineConfig({ input: '../contracts/openapi.json', output: 'src/api/generated', plugins: ['@hey-api/client-fetch', { name: '@hey-api/sdk', validator: true }, 'zod', '@tanstack/react-query'] })`. Confirm the plugin names against the 0.99.0 docs before writing the file.
- **Acceptance:**
  - `pnpm -C web build` → exit 0.
  - The drift command → exit 0.
  - In a throwaway PR, change a pydantic field and see `contract-drift` go red, then revert.
- **Cost settings ($0 audit):** `next.config.ts` sets `images: { unoptimized: true }`; the generated client's base URL is the same-origin `/api` (the proxy, §12.3), never `*.run.app` (which is IAM-gated); ~~`NEXT_PUBLIC_API_BASE_URL` = the front-door URL~~ is superseded.
- **Do not:** hand-write API types, add a PWA, or add rewrites to `next.config.ts`.

### WP-16 Web booking flow + deploy (tier M, T2, cut 1st), depends on WP-15
- **Pages and components** as in §7 (the doctor list is `/doctors`; the lean-core landing page `/` gains a "Book an appointment" link, §12.3):
  - `patient-picker.tsx`: create a patient, or pick a seeded demo patient. The choice is stored in `localStorage` (`clinic.patientId`), with every read and write wrapped in try/catch.
  - `demo-banner.tsx`: "Demo mode: no authentication."
- **Data:** client components with TanStack Query, following the official `getQueryClient()` pattern (staleTime 30 s). Availability uses `refetchInterval: 15000`, `refetchOnWindowFocus: true`, and stops after 10 minutes without interaction (`idle.ts`), showing a "Paused, click to refresh" chip.
- **Errors:** `errors.ts` maps every `ProblemCode`, typed with `satisfies Record<ProblemCode, string>`. A 409 `SLOT_TAKEN` shows a toast and invalidates the availability query.
- **Idempotency key:** `useRef(crypto.randomUUID())`, created once per dialog open and reset on success.
- **CircleCI `ship-web`** (after `ship-api`, context `vercel-prod` restricted to main) exists since WP-11 Part C and is lean core (§12.3); this WP changes nothing in it.
- **Acceptance:**
  - On the Vercel prod URL: pick Dr. Otieno → the first date with slots → book → it appears in "My upcoming" → cancel with a reason → the slot reappears.
  - A slot taken via curl → the UI shows the "just taken" copy.
  - The dark-mode toggle works.
  - Vercel shows exactly one production deployment per merge.
- **Do not:** use Server Actions as a queryFn, or treat `proxy.ts` as an auth boundary.

### WP-17 README + ADR finalization + error catalogue (tier M drafts; tier E owns §11), depends on all shipped WPs
- **Files:** `README.md` per §9, `docs/adr/*` status updates (for example, recording btree_gist availability), `docs/runbooks/rollback.md`, `scripts/docs_check.py`.
- **Acceptance:**
  - `make docs-check`: every relative link and anchor resolves, and every ADR has the 7 headings.
  - Every URL in README §1 returns 200 via `curl -fsS`.
  - README §11 holds only `<!-- ENGINEER: ... -->` slots plus factual bullets the engineer has confirmed.
  - README §10 includes the honest number of hours spent.
- **Do not:** invent prompts, anecdotes, or "decisions without AI".

### WP-18 Release & fresh-clone verification (tier E + S), depends on WP-17
- **Acceptance:**
  - `git clone <repo> "$TMPDIR/fresh" && cd "$TMPDIR/fresh" && make up && make test` → all green within 10 minutes.
  - `python scripts/verify_claims.py --base-url "$PUBLIC_API"` → all PASS.
  - `git tag -a v1.0.0 -m "Submission" && git push --tags`. The tag pipeline runs no workflow: confirm on CircleCI.
  - The README records the release SHA.
  - `git log --format='%B' | rg -i 'co-authored|generated with'` → no output.

### Stretch tier work packages (start only after Gate B)

**Preamble: rules that every WP-S* PR must satisfy**, in addition to the global rules above.
1. **Entry.** Gate B passed by its deadline (§0: Sun 18 Oct 23:59 EAT, evidence in `docs/evidence/gate-b.txt`), and the lean core is not red. Red means the `main` pipeline is failing, or a lean-core WP is not merged by the end of its scheduled day. The check runs at the start of every stretch session; if the lean core is red, or becomes red mid-session, the stretch executor stops and helps, or idles.
2. **Lean-core path guard.** The PR's diff touches none of the lean-core behaviour files:
   `git diff --name-only origin/main...HEAD -- backend/app/domain/slots.py backend/app/domain/booking_rules.py backend/app/domain/events.py backend/app/services/booking.py backend/app/services/availability.py backend/app/services/patients.py backend/app/api/routers/doctors.py backend/app/api/routers/appointments.py backend/app/api/routers/patients.py backend/app/repositories/errors.py backend/app/repositories/doctors.py backend/app/repositories/patients.py backend/app/repositories/appointments.py backend/app/repositories/events.py` → no output. `backend/app/domain/errors.py` may only gain lines: `git diff origin/main...HEAD -- backend/app/domain/errors.py | rg '^-[^-]'` → no output. (WP-S1a's migration changes the event table through a column default only, which is why the booking service needs no change.)
   The files that can change every endpoint at once are guarded too:
   - Untouched: `git diff --name-only origin/main...HEAD -- backend/app/core/middleware.py backend/app/core/cors.py backend/app/core/problems.py backend/migrations/env.py` → no output.
   - Additive only: `git diff origin/main...HEAD -- backend/app/main.py backend/app/core/config.py | rg '^-[^-]'` → no output.
   - `main.py` gains router registration only: `git diff origin/main...HEAD -- backend/app/main.py | rg '^\+[^+]' | rg -v 'include_router\(admin|^\+\s*from app\.api\.routers import admin|^\+\s*$'` → no output. No global dependency, middleware or exception handler may be added for stretch work.
   - Migrations are new files only: `git diff --name-status origin/main...HEAD -- backend/migrations/versions | rg -v '^A'` → no output.
3. **Contract guard.** Existing operations are byte-identical, including their declared `responses`: `diff <(git show origin/main:contracts/openapi.json | jq -S '.paths | with_entries(select(.key | startswith("/admin") | not))') <(jq -S '.paths | with_entries(select(.key | startswith("/admin") | not))' contracts/openapi.json)` → no output. The only allowed changes under `components` are new `ProblemCode` enum members, new `Admin*` schemas and (S3) a `securitySchemes` entry. Runnable checks:
   - Other schemas unchanged: `diff <(git show origin/main:contracts/openapi.json | jq -S '.components.schemas | del(.ProblemCode) | with_entries(select(.key|test("^Admin")|not))') <(jq -S '.components.schemas | del(.ProblemCode) | with_entries(select(.key|test("^Admin")|not))' contracts/openapi.json)` → no output.
   - `ProblemCode` only grows: `jq -n --argjson a "$(git show origin/main:contracts/openapi.json | jq '.components.schemas.ProblemCode.enum')" --argjson b "$(jq '.components.schemas.ProblemCode.enum' contracts/openapi.json)" '($a - $b) | length'` → `0`.
   - Nothing else under `components` changes: `diff <(git show origin/main:contracts/openapi.json | jq -S '.components | del(.schemas, .securitySchemes)') <(jq -S '.components | del(.schemas, .securitySchemes)' contracts/openapi.json)` → no output.
4. **Regression.** `make test` → all passed (this includes the Schemathesis run over every existing path, so a behavioural change that keeps the schema identical is still caught), and after deploy `python scripts/verify_claims.py --base-url "$PUBLIC_API"` → all PASS.
5. **Cut-off.** Not merged and green in prod by Wed 21 Oct 16:00 EAT → dropped; branch left unmerged; README §4.4 says "designed, not shipped".
6. **Versions.** Every new dependency (Go 1.26 toolchain, pgx v5, recharts, Serwist, next-auth v5, Turnstile widget package if any) is resolved from the registry and written to `docs/versions.md` with source and date, as in WP-00. A pre-release pin is recorded as debt. Observed on 2026-10-16 (`npm view next-auth dist-tags --json`): `latest` is `4.24.15` and v5 exists only as `beta` `5.0.0-beta.32`, so S3 as designed pins a beta (TD27, K34).

**Parallel groups (stretch).** [P-S1] WP-S1a then WP-S1b ∥ WP-S1c (WP-S1c's endpoint needs only WP-S1a; its deploy steps need WP-S1b). WP-S1d after WP-S1c and Gate C. [P-S2] WP-S2 ∥ WP-S4 after WP-16. WP-S3 after WP-S1d. Executor time still follows the cut order: WP-S4 runs only when the higher-priority stretch WPs available that day are already underway, and never delays them.

### WP-S1a Commit-safe event cursor + `clinic_realtime` role (tier M; Neon role creation tier E), depends on Gate B
- **Precondition, before merging (tier E, in this order):**
  1. Create `clinic_realtime` on Neon as `clinic_owner` per the runbook, then confirm: `psql "$OWNER_URL" -tAc "select 1 from pg_roles where rolname='clinic_realtime'"` → `1`.
  2. `psql "$OWNER_URL" -tAc "show max_prepared_transactions"` → `0` (rules out 2PC holding the horizon; recorded in `docs/versions.md`).
  Migration `0003` no longer fails without the role (§5), so skipping this cannot break `ship-api`; it would only leave the gateway without grants, which the S1c smoke catches. The precondition still comes first so prod and CI hold the same privilege model.
- **Branching.** Rebase onto `main` after WP-14 merges, or after WP-14 is formally cut, and set `down_revision` to the actual head (§5 "One head, always").
- **Files:**
  - `backend/migrations/versions/0003_event_cursor.py`: DDL exactly as in §5, upgrade and downgrade. The `drop column` line of the downgrade carries `# contract-ok: downgrade only` on the `op.execute` line so `migration_lint.sh` passes.
  - `backend/docker/initdb/02-realtime-role.sql` (`CREATE ROLE clinic_realtime LOGIN PASSWORD 'clinic_realtime_local' NOSUPERUSER NOCREATEDB NOCREATEROLE;`, local/CI only).
  - `.circleci/config.yml`: `backend-test` runs `02-realtime-role.sql` right after `01-roles.sql`; the `dast` compose stack mounts the same `initdb` directory (confirm it does; add the mount if not); `backend-quality` gains `cd backend && test "$(uv run alembic heads | wc -l)" -eq 1`. **The PR is not mergeable until CI creates both roles.**
  - `docs/runbooks/neon.md` (append): create `clinic_realtime` in SQL as `clinic_owner`, password from `openssl rand -base64 32`, never echoed; apply the two `GRANT`s from `0003` idempotently (they are no-ops if `0003` already granted them); set `idle_in_transaction_session_timeout` on `clinic_app`, `clinic_realtime` and `clinic_owner` (§5 roles). The secret version for `clinic-database-url-realtime` is added in WP-S1c, once Terraform has created the container.
  - `backend/tests/integration/test_event_cursor_column.py`, additive cases in `backend/tests/integration/test_db_roles.py`.
  - `contracts/events/appointment-event.v1.schema.json`.
  - Problem codes **INVALID_CURSOR, STREAM_LIMIT_REACHED, STREAM_CAPACITY, and since §12.4 STREAM_TICKET_REQUIRED and STREAM_BUDGET_EXHAUSTED only** (the ADMIN_* codes belong to WP-S3 and the BOT_CHECK_* codes to WP-S4): `app/domain/errors.py`, `docs/api-errors.md`, the regenerated `contracts/openapi.json` and `web/src/api/generated/**`, and ~~three~~ five entries in `web/src/lib/errors.ts` (the last two only if `web/` exists on `main`).
- **Acceptance:**
  - **Local reset first.** initdb scripts run only on a fresh volume, so run `docker compose down -v` before `make up`, or apply the role to an existing volume with `docker compose exec db psql -U clinic -d clinic -f /docker-entrypoint-initdb.d/02-realtime-role.sql`.
  - Column shape: `docker compose exec db psql -U clinic -d clinic -tAc "select format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid) from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid='appointment_events'::regclass and a.attname='txid'"` → `xid8|t|pg_current_xact_id()`. Index: `docker compose exec db psql -U clinic -d clinic -tAc "select indexdef from pg_indexes where indexname='ix_events_txid_id'"` → a line ending in `USING btree (txid, id)`. (Same query shape run on a throwaway PG 17.11 on 2026-10-16 printed `xid8|t|pg_current_xact_id()`.)
  - No rewrite: `docker compose exec db psql -U clinic -d clinic -tAc "select provolatile from pg_proc where proname='pg_current_xact_id'"` → `s`; recorded in `docs/versions.md`.
  - **Same-transaction proof (real booking path, run as the owner role in `test_event_cursor_column.py`):** after booking, cancelling and rescheduling through the API, the latest event of each appointment was written by the same transaction as the appointment's current row version: `SELECT bool_and(e.xmin = a.xmin) FROM appointments a JOIN LATERAL (SELECT xmin FROM appointment_events WHERE appointment_id = a.id ORDER BY id DESC LIMIT 1) e ON true` → `t`. (Cancel and reschedule UPDATEs write a new tuple, which is why only the latest event per appointment is compared.) A secondary check, `bool_and((txid::text::numeric % 4294967296) = xmin::text::numeric)`, holds only when the writes use no SAVEPOINT; the executor reads `services/booking.py` and drops this secondary check, saying so in the PR, if the booking path uses `begin_nested()`.
  - **Atomicity (negative test):** in the same file, `monkeypatch` the events repository's insert so it awaits the real insert and then raises; `POST /appointments` → 500, and afterwards neither an `appointments` row nor an `appointment_events` row exists for that patient. No lean-core file changes; the patch lives in the test.
  - As `clinic_realtime`: `SELECT id, txid, doctor_id FROM appointment_events` succeeds; `SELECT appointment_id FROM appointment_events`, `SELECT 1 FROM patients`, `SELECT 1 FROM appointments` and `INSERT INTO appointment_events DEFAULT VALUES` each fail with SQLSTATE 42501.
  - `uv run pytest tests/integration/test_event_cursor_column.py tests/integration/test_db_roles.py tests/migrations -q` → all passed (the round-trip includes the 0003 downgrade).
  - `bash scripts/migration_lint.sh` → exit 0. `cd backend && uv run alembic heads | wc -l` → `1`.
  - Contract and codegen: `make openapi && pnpm -C web gen:api && git diff --exit-code contracts web/src/api/generated` → exit 0 and `pnpm -C web build` → exit 0, both run only when `web/` exists on `main`.
  - **Lean core unaffected:** after WP-S1a merges, a PR touching only lean-core files is green on `backend-test` and `dast` (link the pipeline in the PR body).
  - On Neon (tier E), as `clinic_realtime`: `SELECT 1 FROM patients` → permission denied; the §5 gateway query with the literals `'0'::xid8` and `0` in place of `$1`/`$2` returns without error; `SELECT pg_snapshot_xmin(pg_current_snapshot())` returns a value. Both outputs are pasted in the PR.
- **Do not:** change any booking/cancel/reschedule code, set `txid` from the app, grant `appointment_id`, add default privileges for `clinic_realtime`, add LISTEN/NOTIFY triggers, or add codes owned by WP-S3/WP-S4.

### WP-S1b Go SSE gateway `services/realtime` (tier M), depends on WP-S1a
- **Files:** `services/realtime/**` (§7), Makefile targets `rt-test rt-test-int rt-lint rt-sec rt-up`, a `realtime` service in `docker-compose.yml` under `profiles: [realtime]` (default `make up` is unchanged) with `ports: ["8081:8080"]`, `depends_on: {migrate: {condition: service_completed_successfully}}` and env `DATABASE_URL=postgres://clinic_realtime:clinic_realtime_local@db:5432/clinic?sslmode=disable`, `WEB_ORIGIN=http://localhost:3000`, `PUBLIC_BASE_URL=http://localhost:8080`, ~~`TRUST_CLOUD_RUN_XFF=false`~~ `TRUST_PROXY_CLIENT_IP=false` (§12.4), `STREAM_AUTH_REQUIRED=false`, CircleCI jobs `realtime-quality` (gofmt, go vet), `realtime-test` (primary `cimg/python:3.12`, the same image as `backend-test`, so `uv run alembic upgrade head` works unchanged; Go installed from the official `go<version>.linux-amd64.tar.gz` with its published sha256 checked, version from `docs/versions.md`; the `cimg/postgres:17.x` secondary image; unit and `-tags=integration`), `realtime-sec` (`govulncheck ./...`, `gosec ./...`), `build-scan-push-realtime` (trivy gate, push on main).
- **Behaviour:**
  - `GET /stream` and `GET /healthz` only, on `net/http` with `http.Server{ReadHeaderTimeout: 5s, IdleTimeout: 60s}` and no `WriteTimeout` (streams), per-stream deadline `STREAM_MAX_SECONDS`.
  - **Poller:** one goroutine per instance, started by the first subscriber and stopped when the subscriber count returns to 0 (zero DB queries while idle). It logs exactly `poller started` and `poller stopped` (slog, level INFO) on those transitions. Each tick runs the single §5 query from the shared cursor and broadcasts rows in `(txid, id)` order.
  - **Pool lifecycle:** the pgx pool is created when the poller starts and closed (`pool.Close()`) when it stops, so an instance with no subscribers holds no DB connection (§3.9).
  - **Lag signal:** each tick also reads `pg_snapshot_xmax(pg_current_snapshot())` (no xid is assigned) and logs `horizon_lag_xids` and `horizon_stall_seconds` (time since the horizon last advanced while xids were in flight); WARN when the stall exceeds `LAG_WARN_SECONDS`.
  - **Join without gap or duplicate:** a new subscriber registers for broadcast first, then runs its own catch-up query from its cursor; it emits catch-up rows, then broadcast rows, sending only rows whose cursor is greater than the last one it sent. More than 1,000 rows behind → `event: reset` and close.
  - **Backpressure:** each subscriber has a 256-event buffer; a full buffer disconnects that subscriber (it resumes from its Last-Event-ID; nothing is lost because the DB is the log). One slow client never blocks the poller.
  - **Limits:** per-IP concurrent cap (~~client IP is the right-most `X-Forwarded-For` entry when `TRUST_CLOUD_RUN_XFF`, else `RemoteAddr`; confirm the position by observation on the first deploy~~, struck by §12.4: behind the proxy every `X-Forwarded-For` entry Cloud Run sees is Vercel's egress, so the cap of 3 would apply to all users together) client IP is `X-Client-IP` when `TRUST_PROXY_CLIENT_IP=true` (Cloud Run; the proxy always overwrites it, and Cloud Run admits only the proxy), else `RemoteAddr`; per-instance cap; both checked before the 200. `MAX_STREAMS_PER_INSTANCE=1` in Cloud Run to match `--concurrency 1`. Go unit tests in `clientip_test.go`: with the flag on, `X-Client-IP` is the key and `X-Forwarded-For` is ignored; with it off, `RemoteAddr` is the key and both headers are ignored.
  - **Ticket (moved from WP-S3 by §12.4):** `internal/ticket` verifies the FastAPI HMAC ticket (`hmac.Equal`, `aud`, `exp`) at connect only; with `STREAM_AUTH_REQUIRED=true` a missing or bad ticket → 401 `STREAM_TICKET_REQUIRED` before any DB work. Tests: expired, tampered-signature, wrong-`aud` and malformed tickets → 401; a valid one → 200; with the flag false, tickets are ignored.
  - **Frames:** `retry: 3000` first; heartbeat `: hb` every 15 s; `event: reconnect` and close at 290 s; on SIGTERM send `event: reconnect` to every stream and exit within 8 s.
  - **DB:** pgx v5 `pgxpool` with `MaxConns=DB_MAX_CONNS`, `MaxConnIdleTime=DB_MAX_CONN_IDLE_SECONDS`, direct (non-pooler) endpoint, `xid8` passed as text, statement timeout 2 s; a DB error closes no streams, it logs and retries on the next tick, and new connects get 503 DB_UNAVAILABLE while the last 3 ticks failed.
- **Tests:**
  - Unit (`go test ./...`): cursor parse/format/compare, including rejection of `""`, `"1"`, `"1.x"`, `"-1.2"`, overflow; limiter; handler framing with `httptest` and an injected clock (heartbeat at 15 s, reconnect at 290 s); subscriber count returns to 0 after client disconnect; the poller issues **zero** queries with zero subscribers (counting fake); every marshalled event validates against `contracts/events/appointment-event.v1.schema.json` and contains none of the keys `appointment_id, patient_id, full_name, phone, email, reason, cancellation_reason`.
  - **Integration set-up** (exactly what `make rt-test-int` does):
    - Schema: locally `docker compose down -v && docker compose up -d --wait db migrate` (initdb creates both roles, `migrate` runs `alembic upgrade head` as the owner). In CI `realtime-test` runs `01-roles.sql` then `02-realtime-role.sql` with `psql` against the secondary image, then `cd backend && uv sync --frozen && uv run alembic upgrade head` as the owner.
    - Env: `RT_TEST_OWNER_URL=postgres://clinic:$POSTGRES_PASSWORD@localhost:5432/clinic?sslmode=disable` (password from `.env.example`, the same value the compose `db` service uses; the writer: inserts fixtures and events) and `RT_TEST_REALTIME_URL=postgres://clinic_realtime:clinic_realtime_local@localhost:5432/clinic?sslmode=disable` (the reader, exactly the gateway's privileges). Locally the `db` port must be published on 5432; if WP-03 did not publish it, WP-S1b adds `ports: ["127.0.0.1:5432:5432"]` to `db` (one added line, declared in the PR body). `make rt-test-int` exports both and runs `cd services/realtime && go test -tags=integration -count=1 ./internal/feed/...`.
    - Fixtures: each test inserts, as the owner, one clinic, one doctor, one patient and one appointment with fixed uuids (so `appointment_events.appointment_id` and `doctor_id` satisfy their foreign keys), and truncates `appointment_events` before each case.
  - Integration (`go test -tags=integration ./internal/feed/...`, real Postgres 17 from compose or the CI secondary image):
    - `TestOutOfOrderCommits`: T1 `BEGIN` and inserts an event; T2 `BEGIN`, inserts an event and commits; poll → **0** rows (T2 is held behind T1's xid); T1 commits; poll → exactly [T1, T2] in that order; poll again → 0 rows. 50 iterations.
    - `TestNaiveIdCursorSkips` (control, same scenario arranged so T1's identity value is lower but it commits last): a naive `id > last_id` reader **loses** T1's row. This proves the scenario really reorders commits and that the xid8 horizon is what saves us (the same philosophy as the booking naive control, ADR-0018).
    - `TestResumeExact`: resuming from any emitted cursor yields exactly the remaining rows.
    - `TestJoinNoGapNoDup`: a subscriber that joins mid-stream receives every row once.
- **Acceptance:**
  - `make rt-test rt-test-int` → `ok` for every package.
  - `cd services/realtime && govulncheck ./...` → `No vulnerabilities found.`; `gosec ./...` → `Issues : 0`.
  - `make up && docker compose --profile realtime up -d --wait realtime && curl -sN --max-time 20 localhost:8081/stream` → output starts with `retry: 3000` and contains at least one `: hb` line.
  - With that curl running, book through the API → the stream prints `event: appointment.booked` with `id: <digits>.<digits>` within 2 s.
  - `curl -s -o /dev/null -w '%{http_code}' 'localhost:8081/stream?cursor=bogus'` → `422`, and the body's `code` is `INVALID_CURSOR`.
  - Per-IP cap: `for i in 1 2 3; do curl -sN --max-time 30 localhost:8081/stream >/dev/null & done; sleep 2; curl -s -o /dev/null -w '%{http_code}' localhost:8081/stream` → `429` (and with `-o -` the body's `code` is `STREAM_LIMIT_REACHED`).
  - After those streams end: `docker compose logs realtime | rg -c 'poller (started|stopped)'` → at least `2`.
  - Image size: `docker image inspect clinic-realtime:local --format '{{.Size}}'` recorded in `docs/versions.md` (ADR-0021 expects well under 30 MB).
  - `circleci config validate` → valid; PR shows the three realtime jobs green.
- **Do not:** add a web framework, use LISTEN/NOTIFY, write to the DB, read `appointment_id`, buffer whole streams in memory, use `WriteTimeout` on the server, or add gRPC/Connect between the services.

### WP-S1c `GET /admin/metrics`, realtime deploy and SSE smoke (tier M; bootstrap tier E), depends on WP-S1a (endpoint) and WP-S1b (deploy)
- **Files:** `app/api/routers/admin.py`, `app/services/metrics.py`, `app/repositories/metrics.py` (new file; SQL lives in repositories as elsewhere), `app/schemas/admin.py`, `tests/integration/test_admin_metrics.py`, regenerated `contracts/openapi.json` and `web/src/api/generated/**`, `scripts/verify_stream.py`, `infra/bootstrap.sh` (append: create `clinic-realtime` once from the hello image with `--no-allow-unauthenticated --region us-east4 --min-instances 0 --max-instances 2 --add-custom-audiences=clinic-realtime`, then ~~bind `allUsers → roles/run.invoker`~~ bind `roles/run.invoker` to `clinic-web` and `clinic-smoke` only; amended by the $0 audit and §12.3), `infra/terraform/{iam.tf, secrets.tf}` (SA `clinic-realtime-runtime`; secret container `clinic-database-url-realtime`; its `secretAccessor` binding; deployer `iam.serviceAccountUser` on the new SA), `.circleci/config.yml` job `ship-realtime`, `docs/runbooks/rollback.md` (realtime section).
- **Secret version (tier E, after `terraform apply` creates the container):** `printf %s "$REALTIME_URL" | gcloud secrets versions add clinic-database-url-realtime --data-file=-`, then `gcloud secrets versions list clinic-database-url-realtime --format=json | jq length` → `1`. Never echoed.
- **Endpoint:** as §6 row 15 and the §5 metrics transaction. `Clock` drives the window; no SQL `now()` in the query.
- **Stream ticket and budget (§12.4; moved here from WP-S3):** `backend/app/core/stream_ticket.py`, `POST /admin/stream-ticket` in `admin.py` (§6 row 16), migration `0004_stream_budget.py` (§5), `app/repositories/stream_budget.py`, Terraform secret container `clinic-stream-ticket-key` with accessor bindings for `clinic-api-runtime` and `clinic-realtime-runtime` only (its version added by the engineer, never echoed). The debit is one statement, with the month taken from `clock.now()` in the clinic zone and bound as a parameter: `INSERT INTO stream_budget (month, debited_seconds) VALUES (:m, :d) ON CONFLICT (month) DO UPDATE SET debited_seconds = stream_budget.debited_seconds + :d WHERE stream_budget.debited_seconds + :d <= :budget RETURNING debited_seconds`, plus a first-insert guard `:d <= :budget`; no row returned → 503 `STREAM_BUDGET_EXHAUSTED`. `tests/integration/test_stream_budget.py`: 20 concurrent ticket requests against a budget of 10 debits → exactly 10 tickets and 10 × 503; a new clinic-local month starts at 0 (FakeClock); `Retry-After` is set. The gateway runs with `STREAM_AUTH_REQUIRED=true` in Cloud Run from this WP on.
- **`ship-realtime`** (depends on `ship-api` and `build-scan-push-realtime`; `serial-group: << pipeline.project.slug >>/deploy-prod-realtime`; context `gcp-deploy`): OIDC → WIF login; `gcloud run deploy clinic-realtime --image "$RT_IMAGE@$RT_DIGEST" --region us-east4 --no-traffic --tag "sha-${CIRCLE_SHA1:0:7}" --service-account clinic-realtime-runtime@$GOOGLE_PROJECT_ID.iam.gserviceaccount.com --set-secrets DATABASE_URL=clinic-database-url-realtime:latest,STREAM_TICKET_KEY=clinic-stream-ticket-key:latest --set-env-vars WEB_ORIGIN=$WEB_ORIGIN,PUBLIC_BASE_URL=$PUBLIC_BASE_URL,TRUST_PROXY_CLIENT_IP=true,MAX_STREAMS_PER_INSTANCE=1,STREAM_AUTH_REQUIRED=true --min-instances 0 --max-instances 2 --concurrency 1 --cpu 0.25 --memory 256Mi --cpu-boost --timeout 300 --add-custom-audiences=clinic-realtime --quiet` (amended by the $0 audit from europe-west3, `--concurrency 100 --cpu 1` and `TRUST_CLOUD_RUN_XFF=true`; ADR-0014 has the CPU arithmetic, WP-00 (a) confirms the 0.25 vCPU combination, fallback `--cpu 0.5`); resolve the tag URL; the C19 gate (WP-12 step 5); `python scripts/verify_stream.py --api-base "$PUBLIC_API" --stream-base "$RT_TAG_URL" --stream-header "X-Serverless-Authorization: Bearer <clinic-smoke token, audience clinic-realtime>"` (~~`--api-base https://<prod api>`~~: the API side goes through the public path, which needs no token; the header applies to the stream base only; each run spends one ticket, 700 s of budget); the newer-commit guard; `update-traffic --to-tags`; prune tags beyond the last ~~3~~ 2 and Artifact Registry versions of `clinic-realtime` beyond the newest 2. `ship-web` does **not** depend on this job.
- **`verify_stream.py`** (httpx streaming; PASS/FAIL table; non-zero exit on any FAIL): `GET /admin/metrics` → 200 with a cursor; `POST /admin/stream-ticket` → 200 (§12.4); `/stream` without a ticket → 401 `STREAM_TICKET_REQUIRED`; open `/stream?cursor=<it>&ticket=<it>` → 200 `text/event-stream`; a heartbeat within 16 s; create a fresh patient, book the first free slot → an `appointment.booked` event with the smoke's own `doctor_id` and `to_starts_at` within 5 s; cancel → an `appointment.cancelled` event with that `doctor_id` and `from_starts_at` within 5 s; no deny-list key in any payload; reconnect with `Last-Event-ID` = the booked event id → the cancel arrives and the booking event never reappears. Every assertion filters on the smoke's own `doctor_id` and slot and ignores unrelated events, so a reviewer booking during the smoke, or a parallel release, cannot fail it; `cursor=bogus` → 422 `INVALID_CURSOR`; `finally` cancels anything still booked.
- **Acceptance:**
  - `uv run pytest tests/integration/test_admin_metrics.py -q` → passed: empty data → all zeros; two bookings and one cancel → `booked=2, cancelled=1` in the right clinic-local hour; `days=15` and `days=0` → 422 `VALIDATION_ERROR`; `Cache-Control: no-store`; no deny-list key anywhere in the body; `cursor` matches `^\d+\.\d+$`.
  - Preamble guards 2-4 pass.
  - Main pipeline green with `ship-realtime`. ~~`python scripts/verify_stream.py --api-base https://<prod api> --stream-base https://<prod realtime>` run 3 times → all PASS.~~ (struck by §12.4: direct run.app hosts answer 403 to anyone without an invoker token; the "Through the front door" run below is the prod check.) One direct check only: `curl -s -o /dev/null -w '%{http_code}' https://clinic-realtime-<hash>.us-east4.run.app/healthz` → `403`.
  - `uv run pytest tests/integration/test_stream_budget.py -q` → passed.
  - `gcloud run services describe clinic-realtime --region us-east4 --format=json | jq -r '.spec.template.spec.timeoutSeconds, .spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"], .spec.template.spec.containerConcurrency, .spec.template.spec.containers[0].resources.limits.cpu'` → `300`, `2`, `1`, `250m` (region and the last two values amended by the $0 audit).
  - **Through the front door ($0 audit):** `python scripts/verify_stream.py --api-base "$PUBLIC_API" --stream-base "$PUBLIC_API"` run 3 times → all PASS, which proves heartbeats flush through the Vercel function within 16 s. **If it cannot pass, S1 is cut** (dashboard falls back to `/admin/metrics` on a click), because a direct browser stream to Cloud Run would bill Africa egress.
  - **Capacity:** with two streams open through the front door, a third `curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_API/stream?ticket=<fresh>"` → the observed status (deduced 429 from Cloud Run) is recorded in `docs/versions.md`, and the dashboard maps it to "Live feed busy".
  - README §10 records a measured cold first-connect time, the Neon compute hours observed for one dashboard tab held open for 30 minutes, and the Cloud Run container memory utilization during that test (Cloud Run metrics; ADR-0021 expects it to be low) (K24).
  - Neon suspend (K24): after the last stream closes, the Neon console (or `neonctl` / the Neon API) shows the compute suspended within 5 minutes plus Neon's configured idle window; the observation and its timestamp go in README §10. Until then "Neon can suspend while nobody watches" stays labelled unverified.
  - Cost check (ADR-0014): the 30-minute test's billed vCPU-seconds from Cloud Run metrics, compared with the ADR's 1,800 vCPU-second estimate. **Amended by the $0 audit:** read `run.googleapis.com/container/billable_instance_time` for `clinic-realtime` over the test window (do not assume it); at 0.25 vCPU the estimate is 450 vCPU-s for 30 minutes. Also record the front-door function's provisioned-memory GB-hours for the same window from the Vercel Usage page, against §13's estimate of 1 GB-h (2 GB × 0.5 h, deduced).
- **Do not:** give the realtime SA access to any other secret, let `ship-web` wait on `ship-realtime`, pass `--allow-unauthenticated`, or run the smoke against prod data other than its own fresh patients.

### WP-S1d `/admin` live dashboard (tier M), depends on WP-S1c and Gate C
- **Files:** `web/src/app/admin/{layout.tsx, page.tsx}`, `web/src/components/admin/{bookings-chart.tsx, utilization-chart.tsx, stream-status.tsx}`, `web/src/lib/{stream.ts, event-schema.ts}`, `web/tests/{stream.test.ts, event-schema.test.ts}`, recharts added at the resolved version.
- **Behaviour:**
  - Initial data from the generated TanStack hook for `GET /admin/metrics` (no polling).
  - `stream.ts` fetches a ticket (`POST /api/admin/stream-ticket` before S3, `/admin/api/stream-ticket` after) and opens `EventSource(NEXT_PUBLIC_REALTIME_URL + "/stream?cursor=" + cursor + "&ticket=" + ticket)`, and owns reconnects itself (a fresh ticket before every connect, §12.4); a 503 `STREAM_BUDGET_EXHAUSTED` shows "Live feed paused for this month, click to refresh" and never retries on a timer: on `reconnect` or error it first calls `es.close()` synchronously (native EventSource would otherwise auto-reconnect on the same URL, giving two live streams against the per-IP cap of 3), then backs off 1 s → 30 s with jitter and reopens with `cursor=<last id>`; on `reset`, refetch metrics and reopen from the new cursor. Dedupe with a `Set` of event ids; ordering, where needed, parses `<txid>.<id>` into a `BigInt` tuple (never string or `Number` comparison).
  - **Cost rule mirrored from §3.7:** close the stream when `document.visibilityState === "hidden"`; close after 10 minutes without pointer or keyboard input (reuse `idle.ts`) and show "Paused, click to resume"; reopen from the last cursor on resume.
  - **$0 audit:** `NEXT_PUBLIC_REALTIME_URL` is `/api` on the same origin (the proxy, §12.3; the gateway's run.app URL is IAM-gated). A "Live feed busy" state handles the capacity refusal when both stream slots are taken. These two closes are what bound the worst case in §13.4, so their tests are acceptance items, not nice-to-haves.
  - Charts: stacked bars of booked/cancelled/rescheduled per clinic-local hour (incremented exactly from the stream); per-doctor utilization bars for today, refetched (debounced 5 s) when a today-dated event arrives, because utilization is derived from appointment state, not from the event series. Every chart has a visually hidden data table for screen readers.
  - Demo banner on `/admin` until S3 ships: "Public demo dashboard: aggregate, non-identifying data only."
  - `event-schema.ts` is a hand-written zod schema for event v1 (the exception to ADR-0011 is recorded there); `event-schema.test.ts` validates every `examples` entry in the JSON Schema with it and asserts `.strict()` rejects an extra `patient_id` key.
- **Acceptance:**
  - `pnpm -C web test` → passed, including: the stream closes on `visibilitychange` to hidden; no reconnect after the idle stop; a duplicate id is applied once; `reset` triggers a metrics refetch; `close()` is called before every reopen (at most one EventSource alive in the fake); the tuple comparison orders `"9.5"` before `"10.1"`.
  - `pnpm -C web build` → exit 0; preamble guards pass.
  - Prod manual (tier E, screenshot in README): open `/admin`, book a slot with curl → the current hour's bar increments within about 2 s; switch tabs → DevTools Network shows the stream closed.
- **Do not:** poll `/admin/metrics` on an interval, render patient data, or change any patient page.

### WP-S2 PWA app shell + dark/light theme (tier M), depends on WP-16
- **First step:** read the Serwist docs for Next 16 and record in `docs/versions.md` which integration applies to the default Turbopack build. Two candidates exist on the registry (both `9.5.13` on 2026-10-16, `npm view`): `@serwist/next` (the webpack `withSerwist` config wrapper) and `@serwist/turbopack` (route-based set-up). Record whether dev mode needs webpack or only warns. If the only working path needs a build change that breaks `next build` or the Vercel build, **drop S2** rather than fight it.
- **Files:** `web/src/app/sw.ts`, `web/src/app/manifest.ts`, `web/public/icons/{icon-192.png, icon-512.png, maskable-512.png}`, `web/src/app/~offline/page.tsx`, `web/next.config.ts` and/or the Serwist Turbopack route, per the doc check (still no rewrites), `web/src/app/layout.tsx` (theme provider props, `theme-color` metas), `web/tests/sw-config.test.ts`.
- **Caching rules:** precache the built app shell (hashed static JS/CSS, fonts, icons) and the `~offline` page only. Do **not** spread Serwist's `defaultCache`; its presets include `NetworkFirst` routes for same-origin `/api` and cross-origin requests. The route list is written by hand:
  - `NetworkOnly` for: navigations (with a `setCatchHandler` that returns the precached `~offline` page when the network fails), RSC requests (`?_rsc=` or header `RSC: 1`), `/api/*` (the proxy, §12.3), `/auth/*` (S3), `/ui/*` (S4), `/docs`, `/redoc`, `/openapi.json`, `/admin` and everything under it, the API origin and the realtime origin.
  - Never `NetworkFirst`, `CacheFirst` or `StaleWhileRevalidate` for any of those: `NetworkFirst` stores every response in Cache Storage and falls back to it on a slow network, which would keep authenticated `/admin` HTML after sign-out on a shared device and could serve stale patient pages.
  - The offline page states that availability and booking need a connection. No background sync.
- **Theme:** next-themes (already in the stack) with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`; `suppressHydrationWarning` on `<html>`; the existing toggle also appears on `/admin`; `theme-color` metas for light and dark.
- **Acceptance:**
  - `pnpm -C web test sw-config.test.ts` → passed. Serwist matches routes first-wins, so the test resolves the **first** matching route for each sample request (a navigation to `/` and to `/doctors/<id>`, an RSC request, `/api/doctors`, `/ui/appointments`, `/auth/session`, `/openapi.json`, `/admin`, `/admin/api/metrics`, an API-origin URL, a realtime-origin URL) and asserts it is `NetworkOnly` or that no route matches. It also asserts that no `NetworkFirst`, `CacheFirst` or `StaleWhileRevalidate` route matches any of them, and that the config does not reference `defaultCache`.
  - `curl -s "$WEB/manifest.webmanifest" | jq -r '.display, (.icons | map(.sizes) | join(","))'` → `standalone` and a list containing `192x192` and `512x512`.
  - `npx lighthouse "$WEB" --only-categories=accessibility --output=json --quiet --chrome-flags=--headless | jq '.categories.accessibility.score'` → ≥ `0.9`. Lighthouse 12 removed the PWA category (release notes; confirm with `npx lighthouse --version` in this WP), so installability is checked in DevTools → Application → Manifest instead (tier E, screenshot).
  - Tier E, DevTools: after a booking flow and an `/admin` visit, Cache Storage holds no entry for the API or realtime origin, no navigation HTML other than `~offline`, and nothing under `/admin` (screenshot); offline reload of `/` shows the shell and the offline notice; dark `prefers-color-scheme` emulation plus a hard reload shows no light flash.
  - `rg -n 'suppressHydrationWarning' web/src/app/layout.tsx` → 1 match. Preamble guards pass.
- **Do not:** cache any API, stream or route-handler response; precache JSON data; enable background sync of bookings (an offline-queued booking would submit against stale availability); add push notifications.

### WP-S3 Google OAuth for the admin area only (tier M; OAuth client, consent screen and allowlist tier E), depends on WP-S1d
- **First step:** record in `docs/versions.md` the output of `npm view next-auth dist-tags --json` (on 2026-10-16: `latest` `4.24.15`, `beta` `5.0.0-beta.32`) and the library's maintenance status as stated on the Auth.js site (the review reports that the Better Auth team took over maintenance in September 2025 and that Auth.js now receives security patches only; this plan has not verified that claim). Pin the exact beta. The API verifies Google tokens on its own, so replacing the web session library later does not move the security boundary (K34, TD27).
- **Files:** `web/src/auth.ts` (Auth.js v5 Google provider; the `jwt` callback keeps `account.id_token` and its expiry in the encrypted session cookie; the `session` callback never exposes it to client JS), `web/src/app/auth/[...nextauth]/route.ts` (Auth.js `basePath: "/auth"`, because `/api/*` belongs to the proxy, §12.3), `web/src/app/admin/layout.tsx` (server-side session check; redirect to sign-in; also forces re-auth when the stored `id_token` expiry is earlier than now plus 60 s), `web/src/app/admin/api/{metrics/route.ts, stream-ticket/route.ts}` (read the id_token server-side and call the API through `call-api.ts` with `Authorization: Bearer` (§12.3; ~~`${API_BASE_URL}`~~ superseded); ~~`export const preferredRegion = "fra1"`~~ no per-route region: the project is pinned to `iad1` in `web/vercel.json` and ~~`API_BASE_URL` is the front-door URL~~ (superseded by §12.3: `call-api.ts` in-process); amended by the $0 audit), ~~`API_BASE_URL` in the Vercel env if WP-S4 has not added it~~ (superseded, §12.3), `stream.ts` (fetch a ticket before every connect; a 401 `ADMIN_AUTH_REQUIRED` from the ticket route redirects to sign-in instead of backing off), `backend/app/core/admin_auth.py` (FastAPI dependency `require_admin`, a no-op while `ADMIN_AUTH_ENABLED=false`), `backend/app/core/stream_ticket.py`, `POST /admin/stream-ticket` in `admin.py`, `backend/tests/integration/test_admin_auth.py`, problem codes ADMIN_AUTH_REQUIRED, ADMIN_FORBIDDEN and ADMIN_AUTH_UNAVAILABLE (this WP owns them) in `app/domain/errors.py`, `docs/api-errors.md`, the regenerated `contracts/openapi.json` and `web/src/api/generated/**`, and `web/src/lib/errors.ts`, `backend/pyproject.toml` + `uv.lock` (`uv add 'pyjwt[crypto]==2.15.1'`; record the resolved `cryptography` version in `docs/versions.md`), Terraform: service account `clinic-smoke` and `roles/iam.serviceAccountTokenCreator` for the deployer **on that SA only** (both already created in WP-11 since the $0 audit; S3 only adds `clinic-smoke` to `ADMIN_EMAILS`), `services/realtime/internal/ticket/*`, Terraform secret container `clinic-stream-ticket-key` with accessor bindings for `clinic-api-runtime` and `clinic-realtime-runtime` only, `--set-secrets STREAM_TICKET_KEY=...` and `STREAM_AUTH_REQUIRED=true` / `ADMIN_AUTH_ENABLED=true` in the two ship jobs. **Amended by §12.4:** the ticket pieces (`stream_ticket.py`, `POST /admin/stream-ticket`, `internal/ticket/*`, the `clinic-stream-ticket-key` secret, `STREAM_AUTH_REQUIRED=true`) already ship with S1 (WP-S1b, WP-S1c) as the carrier of the stream budget; where this list names them, read "already present". WP-S3 adds `require_admin` in front of the ticket route and `/admin/metrics`, and `ADMIN_AUTH_ENABLED=true` in `ship-api`.
- **Verification (`require_admin`):** PyJWT (`pyjwt[crypto]` 2.15.1; the `crypto` extra brings `cryptography`, which RS256 needs; plain `pyjwt` fails at runtime on RS256) with `PyJWKClient` on `https://www.googleapis.com/oauth2/v3/certs`, cached with single-flight refetch and a 60 s cooldown (ADR-0012); `algorithms=["RS256"]` only; `iss` in {`https://accounts.google.com`, `accounts.google.com`}; `aud == GOOGLE_OAUTH_CLIENT_ID`; `exp` with 30 s leeway; `email_verified is True`; lowercased `email` in `ADMIN_EMAILS`. Role, `hd` and any other claims are ignored. The JWKS URL is injectable so tests serve their own keys.
- **Ticket:** FastAPI signs `base64url(json{v:1, aud:"clinic-realtime", exp}) + "." + base64url(HMAC-SHA256(key, payload))`; Go checks it with `hmac.Equal`, `aud` and `exp` at connect only. No email and no `jti`: the ticket is reusable until it expires (60 s), which we state rather than imply single use (TD21).
- **Acceptance:**
  - `uv run pytest tests/integration/test_admin_auth.py -q` → passed, for **both** flag values. With `ADMIN_AUTH_ENABLED=false`: `/admin/metrics` and `POST /admin/stream-ticket` → 200 without a header. With `true`: no header → 401 `ADMIN_AUTH_REQUIRED` with `WWW-Authenticate: Bearer`; wrong `aud`, wrong `iss`, expired, `alg: none` and HS256-signed tokens → 401; valid but not allowlisted → 403 `ADMIN_FORBIDDEN`; `email_verified: false` → 403; valid and allowlisted → 200; JWKS unreachable with no cached key → 503 `ADMIN_AUTH_UNAVAILABLE`.
  - `make rt-test` → `ok` (the ticket cases now live in WP-S1b, §12.4).
  - Prod, after deploy, from a machine with no credentials (rewritten against the web origin by §12.4; direct run.app hosts answer 403 from IAM before the app runs): `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/admin/metrics"` → `401`; `curl -s -o /dev/null -w '%{http_code}' -X POST "$PUBLIC_API/admin/stream-ticket"` → `401`; `curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_API/stream"` → `401`; `python scripts/verify_claims.py --base-url "$PUBLIC_API"` → all PASS (patient endpoints untouched).
  - Prod, tier E: an allowlisted Google account signs in and the dashboard streams; a non-allowlisted account sees the 403 page.
  - Token minting (in CI, from the WIF-derived deployer credential): `gcloud auth print-identity-token --impersonate-service-account=clinic-smoke@<project>.iam.gserviceaccount.com --audiences=$GOOGLE_OAUTH_CLIENT_ID --include-email | cut -d. -f2 | base64 -d 2>/dev/null | jq -r '.aud, .email_verified'` → the client id and `true` (pad the base64 segment if `base64 -d` complains). Whether this works from WIF is **unverified** until this step runs.
  - Smoke after S3: `verify_stream.py --id-token-cmd "<the command above, without the pipe>"` with `clinic-smoke@...` in `ADMIN_EMAILS`, and the full positive stream check (metrics, ticket, heartbeat, booked/cancelled events) still runs on every realtime release.
  - **If minting cannot be made to work, S3 does not merge (it is dropped).** We do not accept a realtime release path whose only smoke is two 401s, because the heartbeat check is the sole guard against Cloud Run buffering SSE frames (K21).
- **Do not:** put a Google token in a URL, `localStorage` or client JS; log tokens or tickets; trust `hd` or role claims; protect any patient endpoint; add a user table or a second database.

### WP-S4 Turnstile on the UI booking route (tier M; widget and keys tier E), depends on WP-16
- **Files:** `web/src/app/ui/appointments/route.ts` (moved off `/api/*`, which is the proxy's, §12.3), `web/src/lib/turnstile.ts`, `web/src/components/book-dialog.tsx` (renders the widget; posts to the same-origin route instead of the generated client's direct call), problem codes BOT_CHECK_FAILED and BOT_CHECK_UNAVAILABLE (this WP owns them) in `app/domain/errors.py`, `docs/api-errors.md` (web-route section), the regenerated `contracts/openapi.json` and `web/src/api/generated/**`, and `web/src/lib/errors.ts`; `web/tests/turnstile-route.test.ts`; `TURNSTILE_EXPECTED_HOSTNAME` in the Vercel env (~~`API_BASE_URL`, only if WP-S3 has not added it~~ superseded, §12.3).
- **Route behaviour** (§6 row 19): `export const dynamic = "force-dynamic"`; ~~`export const preferredRegion = "fra1"`~~ no per-route region (project pinned to `iad1`, $0 audit); forwards through `call-api.ts` in-process (§12.3; before, it read `API_BASE_URL` = the front-door URL); the forwarded body is parsed with the generated zod schema for the `POST /appointments` request (so codegen drift still reaches this write); the widget is rendered with `action: "book"`; POST `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response` and an `idempotency_key` for the siteverify retry, 3 s timeout; on `success:false`, a `hostname` other than `TURNSTILE_EXPECTED_HOSTNAME`, or an `action` other than `book` → 422 `BOT_CHECK_FAILED`; on network error or timeout → 503 `BOT_CHECK_UNAVAILABLE` and nothing is forwarded; on success forward `{doctor_id, patient_id, starts_at}` plus `Idempotency-Key` and `X-Request-ID` to `POST /appointments` through `call-api.ts` with `cache: "no-store"` and return the upstream status, body and `Location`/`Idempotent-Replayed` headers unchanged. A UI retry of the same booking re-runs the widget, because tokens are single-use.
- **Acceptance:**
  - `pnpm -C web test turnstile-route.test.ts` → passed (mocked `fetch`): success forwards exactly once with the token stripped from the body; `timeout-or-duplicate` → 422 and no forward; siteverify timeout → 503 and no forward; an upstream 409 `SLOT_TAKEN` comes back unchanged.
  - Unit cases also cover: wrong `hostname` → 422; wrong `action` → 422; a body that fails the generated zod schema → 422 `VALIDATION_ERROR` and no siteverify call.
  - **Local end-to-end with Cloudflare's test keys** (there is no preview-deploy path: `web/vercel.json` disables Git deploys and `ship-web` deploys prod only). First confirm the key values against Cloudflare's Turnstile testing docs and record them in `docs/versions.md`; the values expected are site key `1x00000000000000000000AA` (always passes), secret `1x0000000000000000000000000000000AA` (always passes) and secret `2x0000000000000000000000000000000AA` (always fails). With `make up` running: `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_EXPECTED_HOSTNAME=localhost API_URL=http://localhost:8080 pnpm -C web build && pnpm -C web start` → a UI booking returns 201. Repeat with `TURNSTILE_SECRET_KEY=2x0000000000000000000000000000000AA` → the dialog shows the 422 `BOT_CHECK_FAILED` copy and no appointment is created. (Test keys may report a fixed `hostname`; if so, record it and set `TURNSTILE_EXPECTED_HOSTNAME` to that value for this local run only.)
  - **The stated bypass, against prod** (direct API use is not bot-protected), run exactly:
    ```bash
    API="$PUBLIC_API"   # https://<clinic-web>.vercel.app/api (§6); direct run.app answers 403
    PID=$(curl -fsS -X POST "$API/patients" -H 'content-type: application/json' -d '{"full_name":"bypass-check"}' | jq -r .id)
    DOC=$(curl -fsS "$API/doctors" | jq -r '.items[0].id')
    for i in $(seq 1 14); do
      D=$(python3 -c "import datetime,zoneinfo as z;print((datetime.datetime.now(z.ZoneInfo('Africa/Nairobi')).date()+datetime.timedelta(days=$i)).isoformat())")
      SLOT=$(curl -fsS "$API/doctors/$DOC/availability?date=$D" | jq -r '.slots[0].starts_at // empty')
      [ -n "$SLOT" ] && break
    done
    BODY=$(jq -nc --arg d "$DOC" --arg p "$PID" --arg s "$SLOT" '{doctor_id:$d, patient_id:$p, starts_at:$s}')
    OUT=$(curl -s -w '\n%{http_code}' -X POST "$API/appointments" -H 'content-type: application/json' -d "$BODY")
    echo "$OUT" | tail -1                                   # expected: 201
    AID=$(echo "$OUT" | head -1 | jq -r .id)
    curl -fsS -X PATCH "$API/appointments/$AID/cancel" -H 'content-type: application/json' -d '{"reason":"bypass check cleanup"}' >/dev/null
    ```
  - Preamble guards pass; `verify_claims.py` → all PASS.
- **Do not:** enforce Turnstile in FastAPI, log tokens, reuse a token across retries, or route reschedule/cancel through the check (out of scope; recorded as TD22).

### Cost-control acceptance checks ($0 audit; referenced from WP-11, WP-12, WP-12a and §13)

Each check names the command and the expected output. `P` = project id, `B` = billing account id. Checks marked *live* also run in `cost_check.sh --live`. Field paths marked (WP-00) are unverified until WP-00 confirms them against the gcloud reference; if a path differs, the check is fixed, never dropped.

| # | Control | Command | Expected |
|---|---|---|---|
| C1 | max/min instances, service-level min and CPU throttling on every Cloud Run service (*live*; extended for cost verifier issue 3) | `gcloud run services list --region us-east4 --project P --format=json \| jq -r '.[] \| [.metadata.name, (.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] // "UNSET"), (.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] // "true"), (.metadata.annotations["run.googleapis.com/scalingMode"] // "automatic")] \| @tsv'` (paths WP-00 (j); `scalingMode` added by §12.4) | `clinic-api 3 0 0 true automatic` (tab-separated; and `clinic-realtime 2 0 0 true automatic` with S1); no `UNSET`, no `false`, no `manual` |
| C2 | No public invoker, by binding or by disabled IAM check (*live*; extended for issue 2) | `for s in clinic-api clinic-realtime; do gcloud run services get-iam-policy $s --region us-east4 --format=json \| jq '[.bindings[]?.members[]] \| map(select(.=="allUsers" or .=="allAuthenticatedUsers")) \| length'; gcloud run services describe $s --region us-east4 --format=json \| jq -r '.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false"'; done` (path WP-00 (j)) | `0` and `false` for each existing service |
| C3 | Direct run.app is an unbilled IAM denial (*live*, added for issue 2; junk bearer added by §12.4) | `curl -s -o /dev/null -w '%{http_code}' https://clinic-api-<hash>.us-east4.run.app/healthz` (no credentials), then the same with `-H 'X-Serverless-Authorization: Bearer junk'`, and both for `clinic-realtime` with S1 | `403` without a token and `401` with the junk bearer, for each service (both codes are dropped by `drop-iam-denied`, C18) |
| C4 | Migration job cannot hang or retry (*live*) | `gcloud run jobs describe clinic-migrate --region us-east4 --format=json \| jq -r '.spec.template.spec.template.spec.maxRetries, .spec.template.spec.template.spec.timeoutSeconds'` (WP-00) | `0` and `600` |
| C5 | Artifact Registry cleanup + size (*live*) | `gcloud artifacts repositories describe clinic --location us-east4 --format=json \| jq -r '(.cleanupPolicies \| keys \| sort \| join(",")), ((.sizeBytes \| tonumber) < 400000000)'` | `delete-old,delete-untagged,keep-2` and `true` |
| C6 | ≤ 2 versions per package (*live*) | `for pkg in $(gcloud artifacts packages list --repository clinic --location us-east4 --format='value(name)'); do echo "$pkg $(gcloud artifacts versions list --package "$pkg" --repository clinic --location us-east4 --format=json \| jq length)"; done` | every count ≤ `2` |
| C7 | ≤ 6 active secret versions (*live*, this project) | `for s in $(gcloud secrets list --format='value(name)'); do gcloud secrets versions list "$s" --filter='state!=DESTROYED' --format=json \| jq length; done \| paste -sd+ - \| bc` | `2` lean core, `4` with S1 + S3, never above `6` |
| C8 | Automatic replication (*live*) | `for s in $(gcloud secrets list --format='value(name)'); do gcloud secrets describe "$s" --format=json \| jq -r '.replication \| keys[0]'; done \| sort -u` | `automatic` |
| C9 | State bucket in a free region | `gcloud storage buckets describe gs://clinic-tfstate-P --format=json \| jq -r '.location, .default_storage_class, (.soft_delete_policy.retentionDurationSeconds // "0")'` (WP-00) | `US-EAST1`, `STANDARD`, `0` |
| C10 | Paid scanners and Cloud Build off (*live*) | `gcloud services list --enabled --project P --format='value(config.name)' \| rg 'containerscanning\|ondemandscanning\|cloudbuild'` | no output |
| C11 | Budgets exist | `gcloud billing budgets list --billing-account=B --format=json \| jq -r '.[].displayName'` | `clinic-alerts-1usd` and `clinic-run-spend-cap-3usd`; the spend-cap action is confirmed by a console screenshot in `docs/runbooks/bootstrap-gcp.md` (its API field is unverified, WP-00 (c)) |
| C12 | Egress alert policy | `gcloud monitoring policies list --project P --format='value(displayName)'` (or `gcloud alpha monitoring policies list` if the GA group is absent) | `clinic-run-egress-daily` |
| C13 | Neon region and fixed size | `neonctl projects get <id> -o json \| jq -r '.project.region_id, .project.default_endpoint_settings.autoscaling_limit_min_cu, .project.default_endpoint_settings.autoscaling_limit_max_cu'` (WP-00; console screenshot as fallback) | `aws-us-east-1`, `0.25`, `0.25` |
| C14 | No other project shares the free tiers | `gcloud billing projects list --billing-account=B --format='value(projectId)'` | only `P`, or every other listed project shows no Cloud Run, Artifact Registry, Secret Manager or Cloud Storage cost in Billing → Reports (screenshot) |
| C15 | Vercel pinned and unbilled | `jq -c '[.regions, .git.deploymentEnabled]' web/vercel.json` (one project since §12.3); `rg -c 'unoptimized: *true' web/next.config.ts` | `[["iad1"],false]`; `1`; Vercel Settings → Billing shows Hobby and no payment method (screenshot) |
| C16 | CircleCI within credits | `rg -n 'docker_layer_caching: *true\|resource_class: *(large\|xlarge\|2xlarge\|.*gen2)' .circleci/config.yml`; Plan → Usage | no output; month-to-date credits below the §13.3 budget and no payment method (screenshot) |
| C17 | The invoice is $0 | Billing → Reports, project P, current month, group by SKU, "Promotions and others" and "Free Tier" savings shown | every SKU's cost after savings is `$0.00`; no "Data Transfer Out" SKU other than "North America to North America"; gross cost per SKU below its free limit (read gross, not net: trial credits would hide an overage) |
| C18 | Logging stays default, plus the one free 401/403 exclusion (*live*; relaxed for issue 7, widened by §12.4) | `gcloud logging sinks list --project P --format='value(name)' \| sort`; `gcloud logging buckets describe _Default --location=global --project P --format='value(retentionDays)'`; `gcloud logging sinks describe _Default --project P --format=json \| jq -r '[.exclusions[]?.name] \| join(",")'` | `_Default` and `_Required` only; `30`; `drop-iam-denied` (~~`drop-iam-403`~~) |
| C19 | CircleCI egress location, **a gate** (§12.4; was a record) | step 5 of `ship-api` and the same step in `ship-realtime`: `test "$(curl -s --max-time 5 https://ipinfo.io/country)" = US`, before any tag-URL call | `US`, else the job fails before any byte is requested from a tag URL and nothing is promoted; CircleCI documents US-only job regions (WP-00 (l)) |

### Schedule (EAT)

| Day | Date | Work | Gate |
|---|---|---|---|
| D1 | Fri 16 Oct | WP-00, WP-01, WP-02 ∥ WP-03, WP-04 ∥ WP-05; **WP-11 part A starts** (Q1-Q3, Q5, Q6 answered today) | - |
| D2 | Sat 17 Oct | WP-06, WP-07, WP-10; **WP-11 part B: `/healthz` live via the main pipeline**; **WP-11 part C: the lean-core `web/` project live** (proxy + landing page; Gate A needs `/api/healthz` and `/docs` through the web URL; §12.3); WP-12a static half | **Gate A:** T0/T1 endpoints green locally AND the walking skeleton live. If missed: drop all T2 (WP-14, 15, 16) and the ZAP job. |
| D3 | Sun 18 Oct | WP-08 ∥ WP-09, WP-12, WP-12a live half | **Gate B:** prod serves all T0/T1 and `verify_claims.py` passes. If missed: drop WP-15 and WP-16, and the whole stretch tier. If passed: the stretch lane below may start. Stretch deadline: passed by Sun 18 Oct 23:59 EAT with `docs/evidence/gate-b.txt` written, or the stretch tier is dropped for good (§0) |
| D4 | Mon 19 Oct | WP-13 ∥ WP-14; WP-15 | - |
| D5 | Tue 20 Oct | WP-16 | **Gate C:** the booking UI works in prod. If missed: ~~remove the web URL from the README and leave `web/` unmerged~~ leave the booking-page branches unmerged; the web URL stays in the README as the API base and Swagger URL (amended by §12.3). |
| D6 | Wed 21 Oct | WP-17; buffer | **FEATURE FREEZE Wed 21 Oct 20:00 EAT**; base-image digest frozen |
| D7 | Thu 22 Oct | Engineer writes README §11; WP-18 by 12:00 | Submit by 15:00 (2 h buffer) |

**Stretch lane (EAT)**, only after Gate B, lower priority than every lean-core cell above on the same day:

| Day | Stretch work | Stretch gate |
|---|---|---|
| D4 Mon 19 Oct | WP-S1a, then WP-S1b ∥ WP-S1c (endpoint part) | none; stops the moment a lean-core D4 WP is red |
| D5 Tue 20 Oct | WP-S1c (deploy + `verify_stream.py`); WP-S1d only after Gate C passes; WP-S2 if WP-16 is merged; WP-S4 only if WP-S1c's deploy is green and WP-S2 is underway, and it never delays WP-S1d | If Gate C is at risk at 16:00, stop all stretch work for the day |
| D6 Wed 21 Oct | WP-S2, WP-S3, WP-S4 in that priority, morning only; WP-17 owns the afternoon and documents only what landed | **Stretch cut-off 16:00 EAT:** anything not merged and green in prod is dropped. Feature freeze 20:00 applies to stretch too |

Realistic expectation, stated so nobody plans around more: S1 is likely to land, S2 possibly, S3 and S4 only if D4 and D5 run clean.

**CUT LINE** (first dropped first). The stretch items go first, all of them before any lean-core item:
- S-1. WP-S4 (Turnstile)
- S-2. WP-S3 (admin OAuth). Before S3 ships, `/admin` and `/stream` stay public, which is acceptable because they carry only non-PII aggregates.
- S-3. WP-S2 (PWA + theme work beyond what WP-16 already ships)
- S-4. WP-S1d, then WP-S1c's deploy, then WP-S1b, then WP-S1a (S1 last). An S1 dropped after WP-S1a merged leaves an unused `txid` column, index and role, the `contracts/events/appointment-event.v1.schema.json` file and ~~three~~ five unused problem codes (and, after WP-S1c, the `stream_budget` table): harmless, expand-only, recorded as TD24.

**Cut line, amended 2026-10-16:** WP-S3 and WP-S4 are cut by the engineer 2026-10-16, deferred with review trigger (ADR-0022: revisit if an admin area ships beyond the unauthenticated aggregates, or if the public booking route sees abuse); they are not scheduled in the D6 row above and their design text (§3.10) stays. WP-S1 and WP-S2 start only after Gate B and only if budget allows.

Knock-on rule: if WP-15/WP-16 are cut for time, every stretch item is already cut (the stretch items go first). If WP-16 is merely not merged at Gate C while WP-S1a to WP-S1c have already shipped, they stay as shipped, evidenced by `curl -N` and `verify_stream.py` output in the README; WP-S1d, WP-S2, WP-S3 and WP-S4 cannot start without the web, so they drop.

Lean-core cut order, unchanged:
1. WP-16, then WP-15 (booking UI pages and codegen only; the proxy route handler, the static doc routes, the landing page, `web-quality`, `ship-web` and `smoke-public` from WP-11 Part C are never cut, so the public URL survives this cut, §12.3, §12.4)
2. WP-14 (idempotency)
3. The ZAP `dast` job from WP-13
4. Terraform in WP-11 (fall back to the gcloud commands in `infra/bootstrap.sh`)

**Never cut:** WP-00 to WP-13 (apart from items 3 and 4 above), which includes WP-11 Parts C0 and C (the proxy, the static doc routes, the landing page, `ship-web`, `smoke-public`), the public URL, WP-09's lean-core contract freshness check, WP-17, WP-18, the race suite with its naive control, CI/CD, the README reasoning, and an honest §11. No stretch item may displace any of these.


### 11.1 Answers (engineer, 2026-10-16)

| Q | Answer |
|---|---|
| 1 | New GCP project `sil-clinic-booking`, ~~owned by developer.ericgitangu@gmail.com, linked to a **dedicated** billing account that the engineer reopens for this project only (one of the closed accounts, e.g. `019163-3D185D-0ACEAD`). It is not linked to "Firebase Payment" (`01C382-12CD13-DCA6EF`).~~ **amended 2026-10-16 (engineer's decision; project and link verified live):** project number `291652953712`, ACTIVE, **owned by `the.ace.guru@gmail.com`** (created there because `developer.ericgitangu@gmail.com` hit Google's project-creation quota; developer holds `roles/editor` and `roles/billing.projectManager`). Billing is linked to the **shared** account `01C382-12CD13-DCA6EF` ("Firebase Payment"), `billingEnabled=True`; it has 5 of 5 project slots in use and no dedicated account could be opened. **Accounts per step:** every IAM, Terraform and WIF step runs as `the.ace.guru@gmail.com` (`GCLOUD_ACCOUNT`, the Owner); billing and budget steps (`infra/billing`, `make cost-check` C11/C14) run as `developer.ericgitangu@gmail.com` (`BILLING_GCLOUD_ACCOUNT`). `bootstrap.sh project` is done. APIs enabled so far: serviceusage, cloudresourcemanager, storage, run. Approval to run `infra/bootstrap.sh` and `terraform apply` is given per run by the engineer. |
| 2 | CircleCI org and project IDs are read after the GitHub repo is connected to CircleCI (the local CLI config could not be parsed). The contexts `gcp-deploy`, `vercel-prod` and `oidc-probe` are approved, restricted to `main`. |
| 3 | Repository `ericgitangu/clinic-booking`, public before the first CI PR. |
| 4 | Vercel team `eric-gitangus-projects`, a single project `clinic-web`. |
| 5 | Confirmed: Cloud Run us-east4, IAM-only; Neon aws-us-east-1; Vercel `iad1`. We accept about +100-150 ms per request from Kenya (unmeasured). |
| 6 | Approved: Neon Free project in aws-us-east-1, database `clinic`, roles `clinic_owner` and `clinic_app`, 0.25 CU fixed. |
| 7 | No custom domain; `*.vercel.app` is the public URL. |
| 8 | Section 4 is written by the engineer from exported transcripts. The candidates the engineer named: CircleCI after the GitHub billing problem; the rule that every extra must justify itself against the brief; the hosting split (Vercel frontend, GCP backend) and the choice of which GCP project to release from the shared billing account. |
| 9 | Deferrals accepted as listed. |
| 10 | Accepted: smoke-test and reviewer patients accumulate in prod until after grading (TD15). |
| 11, 12 | ~~Google OAuth client and Turnstile keys are created by the engineer, and only if S3 or S4 is reached.~~ **Moot:** S3 and S4 are cut by the engineer 2026-10-16, deferred with review trigger (ADR-0022), so no OAuth client or Turnstile keys are created. |
| 13 | Confirmed as written. |
| 14 | ~~The dedicated account is a Paid account (no Free Trial), with its own budget and alerts.~~ **Amended 2026-10-16:** the account is the shared "Firebase Payment" account, so there is no dedicated account and no account of our own. It is `open=True`; whether it is Paid or a Free Trial is **UNVERIFIED** (the Billing API does not expose it; check the console before the first deploy, K42). The budgets are scoped to this project (`infra/billing`), not to the account, because the account already bills other projects (§13.8). |
| 15 | ~~**Resolved by Q1.** "Firebase Payment" carries 10 Cloud Run services in other projects (nanolend-api 5, master-crossing-435409-r1 3, pawacloud-assessment 2, observed 2026-10-16), which would share the per-billing-account free tiers. The dedicated account carries only `sil-clinic-booking`, so §13 stays valid as computed. C14 asserts exactly one project on the account.~~ **Reopened by Q1's amendment.** The account carries 5 projects (ours, `nanolend-api`, `master-crossing-435409-r1`, `pawacloud-assessment`, `unicorns-484301`) and 14 Cloud Run services in the other four (observed 2026-10-16), so the free tiers are shared. §13.8 recounts them from 30 days of measured usage. C14 now asserts the account holds exactly the projects in `scripts/shared_billing_projects.txt`, so a sixth project fails the check until it is measured with `make shared-headroom`. |
| 16 | Accepted: the unpaid interview submission is treated as non-commercial personal use on Vercel Hobby (a judgment call). |
| 17 | Approved: a $3 gross Cloud Run spend cap, accepting that the API pauses if it trips. Eligibility is checked in WP-00. **Amended 2026-10-16:** the cap is scoped to this project and cannot see the other projects' use of the shared free tier, so it does not protect the discount the other projects spend; creating budgets needs billing rights on the account, which only `developer.ericgitangu@gmail.com` has (whether `roles/billing.projectManager` suffices to create budgets is UNVERIFIED). Whether the account lets the console turn a budget into an enforced cap stays UNVERIFIED. |
| 18 | Confirmed: Neon, Vercel, CircleCI, Cloudflare and Docker Hub stay on free plans with no payment method. |
| 19 | Alert recipient: developer.ericgitangu@gmail.com (held in the notification channel, not in the repo). |
| 20 | Unanswered; decided if the C19 gate ever fails. |

---

# 9. README blueprint

```
# Clinic Booking API
<one-line pitch> · CircleCI badge (main) · tag v1.0.0 @ <sha>

## 1. Live URLs
Web project URL `$WEB` (landing page) · API base `$PUBLIC_API` · Swagger `$WEB/docs` · ReDoc `$WEB/redoc` · `$WEB/openapi.json` · booking UI pages (if shipped) ·
<!-- IF S1 SHIPPED --> Realtime stream URL · Admin dashboard /admin (if WP-S1d shipped) <!-- END IF --> ·
CircleCI: one green PR pipeline, one green main pipeline (public repo; screenshots as fallback)

## 2. Verify the claims in 10 minutes
Step 0: create your own patient (POST /patients) -- shared demo patients collide across reviewers.
Swagger walkthrough (book -> 409 -> 422s -> cancel -> rebook -> reschedule) ·
`make verify URL=...` (the same script CI runs before promoting) · `make test-race` locally

## 3. System design                                     <- Section 1 "models, components"
3.1 Context/container diagram · 3.2 Data model (mermaid ERD) · 3.3 Slot computation ·
3.4 Concurrency guarantee (partial unique index; why not locks/SERIALIZABLE; how the harness proves it races) ·
3.5 Appointment state machine & reschedule atomicity · 3.6 Time model · 3.7 UI freshness (polling, why no push yet)
<!-- IF S1 SHIPPED --> 3.8 Realtime admin feed: xid8 commit-safe cursor, why not LISTEN on Neon, the out-of-order-commit
    test and its naive-cursor control, fan-out limits <!-- END IF -->

## 4. Key decisions & trade-offs                        <- Section 1 "key decisions, trade-offs"
Condensed table: decision -> trade-off accepted -> review trigger -> ADR link
4.1 Considered and deferred (one line each + trigger): SSE live availability for patients, API auth for patients
    + demo tokens, rate limiting beyond the per-IP SSE cap, booking cap, API-side bot protection,
    plus any stretch item below that did not ship (moved here, not hidden)
4.2 Considered and rejected: tRPC, GraphQL, gRPC/Connect, h2c, Go in the write path, moon, a PWA that caches
    API data, Redis (until the fan-out trigger), reCAPTCHA v3, Pusher/Ably
4.3 Answer: "tRPC, gRPC and TanStack together?"
4.4 Stretch tier: what shipped and what did not
    Opens with: "The required scope was complete in prod on <Gate B timestamp from docs/evidence/gate-b.txt>;
    everything below was added afterwards." Kept short and clearly secondary to sections 3-4.3.
    One row per item S1-S4: SHIPPED (merge SHA, prod evidence: verify_stream.py output / screenshot / curl)
    or NOT SHIPPED (dropped at <gate or cut-off>, designed in ADR-00xx). Never describe an unshipped item
    in the present tense.
    <!-- IF S1 SHIPPED --> S1: Go gateway, why Go for this one job (ADR-0021), cost observed <!-- END IF -->
    <!-- IF S2 SHIPPED --> S2: PWA shell, network-only data rule, Lighthouse a11y score observed <!-- END IF -->
    <!-- IF S3 SHIPPED --> S3: admin-only OAuth; reviewers cannot sign in unless added to the allowlist and
         the consent screen's test users, so /admin evidence is a recording plus the verify_stream.py output
         and the two unauthenticated 401 curls; offer to allowlist a reviewer's Google account on request;
         patient API still unauthenticated <!-- END IF -->
    <!-- IF S4 SHIPPED --> S4: Turnstile on the UI route only; direct API calls are not bot-protected <!-- END IF -->

## 5. API reference & error catalogue                  <- Section 2 "meaningful errors + status codes"
Endpoint table · status rule (404/422/409) verbatim · code -> status -> when (from docs/api-errors.md)

## 6. Code structure                                    <- Section 2 "sensible structure"
## 7. Testing                                           <- Section 2 "basic test coverage"
Pyramid; race-test assertions (incl. lock-waiter proof and naive control); observed coverage %; how to run each layer

## 8. Ambiguities & decisions                           <- "when ambiguous, decide and note"
## 9. Deployment & CI/CD                                <- Section 3
Which branch deploys (main) and how (GitHub App trigger -> `release` workflow); every pipeline step;
OIDC/WIF (subject mapping, audience, condition) + the two deny logs; context restrictions;
migrations-first ordering and why it is safe (expand-only + lint + advisory lock); tagged smoke + promote-by-tag;
the newer-commit guard; rollback runbook; fork-PR limitation; VERCEL_TOKEN debt
## 10. Operations, cost & security posture
Cost table (estimates vs observed) · measured cold/warm latency · region trade-off + KDPA note ·
$0 proof: link to PLAN §13, the Billing report screenshot (C17, gross and Free Tier savings), billing account type
    (Paid, not Free Trial), Neon CU-hours used, CircleCI credits used, Vercel Hobby non-commercial note ·
**No authentication: IDOR statement** and how auth would layer in · phone-exists oracle ·
<!-- IF S3 SHIPPED --> admin auth posture (Google ID token checks, allowlist, ticket-in-URL trade-off) <!-- END IF --> ·
<!-- IF S4 SHIPPED --> bot-check bypass via direct API, stated plainly <!-- END IF --> ·
<!-- IF S1 SHIPPED --> realtime cost: measured cold connect, Neon hours for one open dashboard tab <!-- END IF --> ·
tech debt ledger · honest hours spent
## 11. AI reflection                                    <- Section 4 (ENGINEER-WRITTEN)
### What I used AI for
<!-- ENGINEER: factual bullets + a per-WP table of how much code was agent-generated vs hand-written -->
### An example where AI improved my work
<!-- ENGINEER: verbatim prompt from the exported session transcript (prompt id from the AI usage summary in README §11), what changed, commit SHA -->
### An example where AI was wrong or incomplete, and how I caught it
<!-- ENGINEER: a real entry with its source; how it was caught (test / doc / observation); fix commit -->
### Two decisions I made without AI, and why
<!-- ENGINEER: decision 1 -- must predate or override AI output; cite the message/commit -->
<!-- ENGINEER: decision 2 -- same rule -->
### Note on commits
AI usage is summarized here in §11; commit messages carry no tooling trailers by convention.
## 12. Run locally
`make up` · `make test` · env vars table · prerequisites (Docker, uv, pnpm)
```

---

# 10. Risk register & tech debt ledger

**Risks**

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| K1 | The asyncpg `sqlstate`/`constraint_name` path differs from `exc.orig.__cause__` (unverified) | Med | High (wrong 409 code) | WP-07's first test pins it |
| K2 | The race test passes for the wrong reason | Med | High | Lock-waiter sampler assertion + naive check-then-insert control (§3.4) |
| K3 | An idempotent retry gets reported as SLOT_TAKEN | Med | Med | Re-check the key on any 23505; race case 5 |
| K4 | The OIDC claim names or CEL condition are wrong, so main can't deploy or a branch could | Med | High | WP-00 doc check; subject under 127 bytes; `allowed_audiences`; WIF + context negative tests in WP-11 |
| K5 | First `--no-traffic` deploy on a new service rejected; missing ~~public~~ front-door invoker | High (without bootstrap) | High | `infra/bootstrap.sh` creates the service and ~~the `allUsers` binding~~ the `clinic-web` (proxy) and `clinic-smoke` invoker bindings once (amended by the $0 audit); CI never sets IAM |
| K6 | Concurrent merges promote an untested revision or race migrations | Med | High | One `ship-api` job under `serial-group`, promote by tag, newer-commit guard, advisory lock |
| K7 | Migrations applied, then the smoke fails, breaking the live revision | Low | High | Expand-only, `migration-lint`. N-1 compatibility test is debt (TD16) |
| K8 | Cold path of 1-3 s (Cloud Run + Neon wake), unmeasured | High | Low | `--cpu-boost`, lazy engine, pre-ping, 503 + Retry-After; measured numbers published |
| K9 | Neon `max_connections` too low for pool × instances | Low | Med | WP-11 records it; pool 5 × 3 = 15 |
| K10 | The region override is rejected | ~~Low~~ Med (the $0 audit changed it to us-east4 + front door) | Med | Q5; switching is a region flag + AR repo + Neon project + Vercel region; ADR-0023 option 2 is the named fallback |
| K11 | ~~Cloud Run free tier doesn't apply in europe-west3~~ **Resolved by the $0 audit:** europe-west3 is Tier 2 (verified, catalog 2026-10-16); moved to us-east4 (Tier 1) | n/a | n/a | ADR-0014 amendment |
| K12 | Vercel double-deploys | Med | Low | `git.deploymentEnabled:false`; verify after the first merge |
| K13 | hey-api 0.x breaking change | Low | Med | Exact pin + drift gate |
| K14 | Scope overrun | Med | High | Reduced T2, gates A/B/C, fixed cut line, freeze Wed 20:00 |
| K15 | §11 fabricated, or AI-originated decisions presented as unaided | Low | **Critical** | ADR-0020: engineer-only slots, decisions must predate or override AI output, transcript export |
| K16 | Shared prod state breaks the smoke test or confuses reviewers | Med | Med | Fresh patients + dynamic slot choice + finally-cleanup; README step 0 |
| K17 | A new base-image CVE blocks a submission-day deploy | Med | Med | Runbook, dated `.trivyignore`, digest frozen at feature freeze |
| K18 | Clock/timezone bugs | Med | High | Clock injection, banned time APIs, SQL `now()` banned in business queries, DST spring + fall tests, local-day-bound test |
| K19 | CircleCI credit burn | Low | Med | Measure after WP-10; DAST on the machine executor only. **$0 audit:** budget 22,200 of 30,000 credits worst case (§13.3); small/medium classes only; no DLC; self-skipping lanes; exhaustion blocks builds and never bills (no card) |
| K20 | The asyncpg URL rejects `sslmode` | Med | Med | Config validator + documented URL form; `/readyz` check in WP-12 |
| K21 | **(Stretch S1)** SSE on Cloud Run: the 300 s request timeout cuts streams, or frames are buffered and never flushed to the client (flushing through Cloud Run's front end is **unverified**) | Med | Med | Server closes at ~290 s with `event: reconnect`; exact resume via `Last-Event-ID`; `: hb` every 15 s; WP-S1c's prod smoke asserts a heartbeat arrives within 16 s, so buffering fails the deploy before promotion. This positive check must keep running after S3: the smoke mints a `clinic-smoke` ID token (deployer has `serviceAccountTokenCreator` on that SA only); if that cannot work, S3 is dropped rather than reduce the smoke to two 401s (WP-S3, ADR-0016) |
| K22 | **(Stretch S1)** Poll load: every instance polls once a second while it has clients | Low (max 2 instances) | Low | Poll only with ≥ 1 subscriber; max-instances 2; one indexed query per tick; ADR-0021 review trigger moves fan-out to a single relay |
| K23 | **(Stretch S1)** The stream horizon stalls behind a long or abandoned write transaction (`xmin` held back), delaying (never losing) events | Low | Low | `idle_in_transaction_session_timeout` on every login role (§5); `max_prepared_transactions = 0` confirmed on Neon (WP-S1a); short transactions by design; per-tick `horizon_lag_xids` / `horizon_stall_seconds` log with a WARN above 10 s; migrations run in seconds with `lock_timeout` 5 s |
| K24 | **(Stretch S1)** An open dashboard keeps Neon compute and a Cloud Run instance awake, eating the free allowance | Med | Low | **$0 audit:** 0.25 vCPU, concurrency 1, max 2 instances; ~~worst case 56 connected hours = 28% of the CPU allowance~~ worst case bounded server-side by the monthly stream budget at 96 connected hours = 48% of the CPU allowance with the API (§13.4, §12.4); spend cap $3 gross as the backstop; Neon fixed at 0.25 CU. Close on hidden tab and after 10 min idle (mirrors §3.7); the gateway closes its DB pool at 0 subscribers; measured in WP-S1c (30-minute tab test: Neon compute hours, billed vCPU-seconds, and whether compute suspends after the last stream closes; unverified until then) and published in README §10; ADR-0014 arithmetic; $1 budget alert |
| K25 | **(Stretch S3)** Google ID-token verification is wrong (alg confusion, wrong `iss`/`aud`, unverified email), letting a non-admin in, or a JWKS outage locks admins out | Low | High | RS256 only, `iss`/`aud`/`exp`/`email_verified` checks, allowlist, one negative test per check; JWKS cache with single-flight and cooldown; 503 `ADMIN_AUTH_UNAVAILABLE` on outage |
| K26 | **(Stretch S3)** Google consent screen in Testing mode admits only listed test users, so reviewers cannot open `/admin` once S3 ships | High | Low | README shows a recording; the engineer adds a reviewer's Google account to the allowlist and test users on request (Q11) |
| K27 | **(Stretch S4)** Bots bypass Turnstile by calling the API directly | High (if anyone tries) | Med | Stated plainly in README §10; real fix is API-side enforcement once API auth exists (TD22) |
| K28 | **(Stretch S2)** A service-worker caching bug serves stale availability, or stale JS after a deploy | Low | High (correctness) | `NetworkOnly` for navigations, RSC, `/api/*`, `/admin/**` and both backend origins, enforced by a first-match `sw-config.test.ts`; no `defaultCache`; no `NetworkFirst` anywhere (it caches and falls back to stale HTML, including `/admin` after sign-out); no data precache; no background sync; offline page instead of cached data; drop S2 on any doubt |
| K29 | **(Stretch S2)** Serwist does not support the Next 16 default build | Med | Low | First step of WP-S2 is the doc check; drop S2 rather than change the build |
| K30 | **(Stretch, all)** Stretch work starves the lean core | Med | High | Gate B entry rule, lean-core-first priority, 16:00 Wed cut-off, cut order S4 → S1 before any lean-core item |
| K31 | **(Stretch S1)** A new Go vulnerability (govulncheck) turns PR checks red on submission day | Low | Med | Go jobs are not dependencies of `ship-api`/`ship-web`; if they block a lean-core merge, cut S1 per the cut line; Go toolchain frozen at feature freeze like the Python base digest |
| K32 | **(Stretch S3)** The stream ticket appears in Cloud Run request logs because it is a query parameter | High | Low | 60 s TTL, no email in it, grants only the non-PII stream; TD21 |
| K33 | **(Stretch S1)** The per-IP cap keys on the wrong `X-Forwarded-For` entry, or is per instance only (**$0 audit:** behind the front door the key is `X-Client-IP`, set by the front door; ADR-0012 amendment) | Med | Low | ~~Right-most entry, confirmed by observation on the first deploy (ADR-0012 rule)~~ `X-Client-IP` when `TRUST_PROXY_CLIENT_IP=true`, else `RemoteAddr`, with a Go unit test for both (WP-S1b, §12.4); the effective cap is 3 × max-instances; TD23 |
| K34 | **(Stretch S3)** The web session library is in maintenance mode or pre-release: next-auth v5 is still `beta` (`5.0.0-beta.32`, observed 2026-10-16), and the review reports Auth.js now receives security patches only | Med | Low | The API verifies Google ID tokens itself, so swapping the web session library does not move the security boundary; exact beta pin; status recorded in `docs/versions.md` (TD27) |
| K35 | **(Stretch S1)** A stretch migration or role blocks a lean-core release: `ship-api` runs `alembic upgrade head` on every merge, so a migration that fails on a missing stretch role would stop every later API release | Med (without the fix) | High | `0003` skips its grants with a NOTICE instead of failing; the Neon role is a WP-S1a merge precondition; CI creates both roles in `backend-test` and `dast`; acceptance shows a lean-core-only PR green after WP-S1a |
| K37 | **($0 audit)** A cost guard silently drifts (max-instances dropped from a deploy line, a third image version, an extra secret version, an `allUsers` binding) | Med | Med (a non-zero invoice) | `cost-static` on every PR and `cost-check` on every release (WP-12a); C1-C19 |
| K38 | **($0 audit)** Vercel OIDC → WIF → `generateIdToken` does not work from a federated principal, so the front door cannot call Cloud Run | Med | High (no public API) | Exact STS and `generateIdToken` calls written in WP-11 Part C (§12.4); single-call fallback with `roles/iam.workloadIdentityUser` (a superset that includes `getOpenIdToken`), no second hop; if both fail by Gate A, the engineer picks ADR-0023 option 2 or holds the gate (Q5) |
| K39 | **($0 audit)** SSE frames are buffered by the Vercel function, so the stream never shows events | Med | Low (stretch) | WP-S1c heartbeat-within-16 s check through the front door; on failure S1 is cut, no direct-to-Cloud-Run fallback |
| K40 | **($0 audit)** A flood through the front door passes 1 GiB of Cloud Run egress before Vercel pauses at 1M invocations: about 165,000 requests of the ordinary mix (about 6.5 KB each, deduced), but ~~165,000~~ only about 12,000 of the largest response a client can trigger uncached (recomputed by §12.4: `GET /patients/{id}/appointments?limit=100` for a patient the attacker first fills with 100 bookings, about 45 KB × 2 overhead, deduced; the doc routes, which made it about 9,000 before, are now static) | Low | Low ($0.105/GiB beyond 1 GiB) | Daily egress alert at 30 MB (fires after about 330 such requests); kill switch (remove the web proxy's invoker binding from `clinic-api` and `clinic-realtime`, ADR-0023); doc routes static, never Cloud Run (§12.4); Vercel also pauses at 1M CDN requests; spend cap $3 gross bounds compute, and egress only if the cap counts network SKUs (the spend-cap page does not say; WP-00 (c), Q17); per-IP 120/min in the front door (weak). This is the one residual path to a non-zero egress line and is stated in §13.6 |
| K41 | **($0 audit)** The Cloud Run spend cap pauses the API mid-grading (gross compute reached $3) | Low | High | The worst case in §13.4 is ~~$1.55~~ $2.49 gross with the stream budget fully spent (§12.4), $0.51 below the cap; the daily alert and the $1 budget at 50% give warning; raising the cap stays below the $4.32 discount |
| K42 | **($0 audit)** The billing account is a Free Trial: it closes after 90 days and stops every resource, and its credits hide overages | Med | High | Q14: use or upgrade to a Paid billing account; prove $0 from gross and Free Tier savings lines (C17), not net |
| K43 | **($0 audit)** Another project on the same billing account consumes the shared Cloud Run, Artifact Registry or Secret Manager free tiers | Med | Med | C14; dedicated billing account or none of the other projects using those products |
| K44 | **($0 audit)** Neon CU-hours run out (an always-awake compute uses 186 a month at 0.25 CU) and the DB suspends during grading | Low | High | Fixed 0.25 CU; idle closes; no pinger; worst case ~~35~~ 45 CU-hours (§13.4, recomputed by §12.4); usage recorded in README |
| K45 | **($0 audit)** Docker Hub rate-limits CircleCI's shared IPs (`toomanyrequests`) on submission day | Med | Med | `mirror.gcr.io` by digest for official images, and `mirror.gcr.io/cimg/*` for the CI executors; no Docker Hub credentials or context (engineer, 2026-10-16; the four `cimg` tags resolved through the mirror when checked with `docker buildx imagetools inspect`) |
| K46 | **($0 audit)** Vercel's fair-use terms: Hobby is for "non-commercial personal use only", and its definition is broad | Low | Med | An unpaid interview submission is deduced to be non-commercial; stated in the README. A front door on Cloud Run instead would not be $0 (its egress to Kenya is billed), so the fallback is ADR-0023 option 2 and the egress line it brings (Q16) |
| K47 | **(§12.3)** A route file added under `web/src/app/api/` shadows a proxied API path (App Router prefers static segments over the catch-all), so for example `/api/appointments` would stop reaching the API | Low | High | `route-layout.test.ts` and the `cost-static` route check; S3 and S4 routes live at `/auth/*` and `/ui/appointments` |
| K48 | **(cost verifier issue 7)** A flood of direct run.app requests is free on Cloud Run but writes request logs; past 50 GiB per project a month ingestion bills $0.50/GiB | Low | Low | Free `_Default` exclusion ~~`drop-iam-403`~~ `drop-iam-denied`, matching 401 and 403, so a junk bearer header no longer reopens the path (WP-11, C3, C18; §12.4); a flood through the proxy is capped by Vercel's 1M invocations and 1M CDN requests, about 1.5 GB of logs at 1.5 KB each (deduced), far below 50 GiB |
| K49 | **(§12.4)** A script holds `/api/stream` open around the clock (the idle close is client-side; before S3 anyone can get a ticket), up to 1,296,000 vCPU-s a month | Med (if anyone tries) | Med (spend cap trips, API paused) | Monthly connected-seconds budget debited at ticket issue (§3.9, WP-S1c); after it, 503 `STREAM_BUDGET_EXHAUSTED` and click-to-refresh metrics; spend cap as the backstop, with its documented lag |
| K50 | **(§12.4)** Manual scaling, a YAML `services replace` or a worker pool keeps instances billed while idle, and C1 as first written would still PASS | Low | Med | Rule 11 and `cost-static` ban them; C1 asserts `scalingMode` is `automatic` |
| K51 | **(§12.4)** A release breaks the public path (OIDC trust, WIF condition, headers, `Location`, a shadowing route) while the tag-URL smoke stays green | Med | High | `smoke-public` after `ship-web`, never cut |
| K36 | **(Stretch S1)** Two alembic heads after WP-14 and WP-S1a are developed in parallel from the same parent, so `alembic upgrade head` errors in prod | Med | High | WP-S1a rebases after WP-14 and sets `down_revision` to the real head; `alembic heads | wc -l` → `1` in `backend-quality` |

**Tech debt ledger (accepted; stated in README §10)**

| # | Debt | Real fix |
|---|---|---|
| TD1 | Fixed, aligned 30-minute slots; the alignment CHECK holds only for whole or half-hour offsets | EXCLUDE gist + btree_gist |
| TD2 | Overlapping working windows prevented only by seed validation | EXCLUDE on `(doctor_id, weekday, timerange)` |
| TD3 | No leave or time-off and no admin CRUD for hours; bookings not re-validated when hours change | Exceptions table + re-validation job |
| TD4 | No completed or no_show states | Extend the state machine |
| TD5 | **No authentication: IDOR on cancel, reschedule and the patient list** | OIDC + ownership dependency (ADR-0012) |
| TD6 | No rate limiting; the public write path is open to abuse | Edge or Redis limiter (ADR-0012) |
| TD7 | `VERCEL_TOKEN` is a long-lived secret (~~only if the web ships~~ lean core since the `web` project carries the proxy, §12.3) | Project-scoped, rotate after grading |
| TD8 | No cursor pagination (`next_cursor` reserved) | Keyset on `(starts_at, id)` |
| TD9 | ~~EU~~ US data residency for a Kenyan clinic (amended by the $0 audit: Neon aws-us-east-1) | African-region DB + KDPA review |
| TD10 | Cancel is not idempotent (the brief mandates it) | n/a |
| TD11 | No distributed tracing or dashboards | OTel to Cloud Trace (ADR-0019) |
| TD12 | Exceptions used for domain errors (FastAPI idiom) | Typed results end to end |
| TD13 | The 90-day horizon is an invented business rule | Product decision |
| TD14 | Phone-exists oracle on `POST /patients` | OTP verification + indistinguishable 202 |
| TD15 | Smoke and reviewer patients accumulate in prod (no delete endpoint) | Retention job |
| TD16 | No automated N-1 schema compatibility test | Run the previous tag's suite against head |
| TD17 | **(Stretch S1)** Each gateway instance polls the DB independently; no single relay | One poller publishing to Upstash Redis pub/sub or Pub/Sub (ADR-0021 trigger) |
| TD18 | **(Stretch S1)** A second language, image, CI lane and deploy unit for one read-only job | Accepted cost (ADR-0021); fold back into FastAPI if the admin feed is dropped |
| TD19 | **(Stretch S1)** The event v1 zod schema is hand-written (exception to ADR-0011), guarded only by the JSON Schema `examples` test | Generate TS/zod from the JSON Schema |
| TD20 | **(Stretch S3)** Admin sessions depend on the Google ID token's lifetime (about 1 h, then re-sign-in); no refresh-token handling | Server-side session with refresh, or a clinic IdP |
| TD21 | **(Stretch S3)** Stream ticket travels in the URL (visible in request logs) and is reusable within its 60 s TTL (no `jti` enforcement); one HMAC key with manual rotation | Two active key versions with scheduled rotation; or cookie auth on a shared parent domain |
| TD22 | **(Stretch S4)** Bot protection covers only the UI booking route; direct API calls, patient creation, cancel and reschedule are unprotected | API-side enforcement once API auth exists (ADR-0012, ADR-0022) |
| TD23 | **(Stretch S1)** Stream caps are per instance and in memory | Shared limiter, delivered with the deferred rate-limiting work (ADR-0012) |
| TD24 | **(Stretch S1)** If S1 is dropped after WP-S1a merged, an unused `txid` column, index and `clinic_realtime` role remain, plus `contracts/events/appointment-event.v1.schema.json` and the ~~three~~ five stream problem codes (and the `stream_budget` table after WP-S1c, §12.4) | A reviewed contract migration later (expand-only rules keep it harmless) |
| TD25 | **(Stretch S1, until S3)** `/admin`, `/admin/metrics` and `/stream` are public (aggregate, non-PII) | S3 |
| TD26 | **(Stretch S1)** Hourly metrics bucket on `occurred_at`, an audit default (`now()`, transaction start), used for reporting only and never in business logic (§3.6) | Stamp `occurred_at` from `clock.now()` as a bind parameter |
| TD28 | **($0 audit)** Every request takes an extra hop through the Vercel front door, and the API depends on Vercel being up | A regional load balancer in front of Cloud Run, once a budget exists for an always-on resource (ADR-0023 review trigger) |
| TD29 | **($0 audit)** Three cost surfaces have no platform cap (Artifact Registry, Secret Manager, Cloud Storage) and egress has only an alert plus a manual kill switch | An automated kill switch (alert → Pub/Sub → a function that removes the invoker binding), itself checked against free tiers first |
| TD30 | **($0 audit)** The front door's per-IP limit is in memory, per function instance | A shared limiter, with the deferred rate-limiting work (ADR-0012) |
| TD31 | **(§12.4, Stretch S1)** The stream budget debits 700 s per ticket, about 2.4 times what an honest 290 s stream uses, so a real dashboard gets about 40 connected hours a month before it falls back to click-to-refresh | Refund unused seconds when a stream closes (needs a write path from the gateway or a close callback to the API), or single-use tickets with a `jti` store |
| TD32 | **(§12.4)** `/docs` and `/redoc` load Swagger UI and ReDoc from jsdelivr at pinned versions; an outage there breaks the docs pages (not the API) | Bundle `swagger-ui-dist` and `redoc` into `web/public` |
| TD27 | **(Stretch S3)** next-auth v5 pinned as a beta (`5.0.0-beta.32` on 2026-10-16) in a library reported to be in maintenance mode | Move the web session to a maintained library; the API boundary stays as is |

---

# 11. Open questions

1. **GCP:** the project ID, project number and billing account, plus approval to run `infra/bootstrap.sh` and `terraform apply` from the engineer's laptop.
2. **CircleCI:** the organization ID and project ID (needed for WIF), plus approval to create the contexts `gcp-deploy` and `vercel-prod` (both restricted to main; `vercel-prod` holds `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, §12.4) and `oidc-probe`.
3. **GitHub:** the final repo name. The local directory is `savannah_informatics_assessnent` (typo); suggested name `clinic-booking`. **Make it public before the first CI PR**, so reviewers can see PRs and pipelines. Also record in ADR-0016 whether Actions would have worked on a public repo despite the billing issue, and why we stayed with CircleCI either way.
4. **Vercel:** the team scope and project name for `web`. ~~Only needed if WP-16 ships.~~ ~~**Amended by the $0 audit:** also the project `clinic-frontdoor`~~ (superseded, §12.3). **Amended by the engineer's decision:** one project, `clinic-web` (name to confirm), lean core and needed by D2 (WP-11 Part C), plus the team slug for the Vercel OIDC issuer. **Amended by §12.4:** the engineer runs WP-11 Part C0 (create `clinic-web`, issuer mode Team, Root Directory empty, the §7 env vars) and records the project's `orgId` and `projectId` in the `vercel-prod` context.
5. **Region:** confirm the europe-west3 override of the africa-south1 default (ADR-0014). **Replaced by the $0 audit:** confirm us-east4 + Neon aws-us-east-1 + the IAM-gated Vercel front door (ADR-0023 option 1), accepting about +100-150 ms per request from Kenya (estimate) and US residency for synthetic data, or choose option 2 (public run.app, a sub-cent but non-zero Africa egress line recorded as a breach of the $0 rule). **Answered 2026-10-16 by the engineer:** option 1, Vercel for the frontend and GCP for the backend, with the front door as route handlers in the single `web` project (§12.3, ADR-0023).
6. **Neon:** approval to create a Free project in ~~aws-eu-central-1~~ **aws-us-east-1** with database `clinic` and roles `clinic_owner` and `clinic_app`, compute fixed at 0.25 CU.
7. **Domain:** confirm there is no custom domain. The `*.run.app` and `*.vercel.app` URLs avoid a paid load balancer.
8. **Section 4:**
   - The engineer must choose two decisions that predate or override AI output and cite where each was made. Candidates the engineer may confirm or replace: choosing CircleCI after the GitHub Actions billing problem; the guardrail that every extra must justify itself against the brief; overriding or keeping the region.
   - The engineer must export the session transcripts rather than reconstruct prompts from memory.
   - "AI was wrong" examples must come from the engineer's own log and cite their source.
9. **Deferrals:** confirm acceptance that SSE for patients, API auth for patients, rate limiting beyond the per-IP SSE cap, the booking cap and API-side bot protection stay deferred. Each is designed in an ADR, with a review trigger, but not built. The admin SSE feed and chart, admin OAuth, the PWA shell and Turnstile on the UI route moved from "deferred" to the gated stretch tier by the engineer's decision (§0, §12.1).
10. **Prod state:** confirm it is acceptable that smoke-test and reviewer patients accumulate in the prod DB until after grading (TD15).
11. **(Stretch S3) Google OAuth:** the OAuth client id and secret (Web application type, redirect URI `$WEB/auth/callback/google` (Auth.js `basePath: "/auth"` since §12.3)) created by the engineer in the GCP project; the consent screen publishing status (Testing admits only listed test users); the admin email allowlist (`ADMIN_EMAILS`); whether to add reviewers' Google accounts on request; and approval for the `clinic-smoke` service account used by the post-S3 smoke, with `roles/iam.serviceAccountTokenCreator` granted to the deployer on that one SA (if the deployer cannot mint its token, S3 is dropped, WP-S3).
12. **(Stretch S4) Turnstile:** the site key and secret key for a widget restricted to the Vercel hostname, created by the engineer in a Cloudflare account. Secret goes to the `vercel-prod` context / Vercel env only.
13. **(Stretch S1) Realtime service:** confirm the Cloud Run service name `clinic-realtime` (~~europe-west3~~ us-east4, 0.25 vCPU, concurrency 1, max 2), its SA `clinic-realtime-runtime`, secrets `clinic-database-url-realtime` and (S3) `clinic-stream-ticket-key`, and approval to create the Neon role `clinic_realtime` and run the `bootstrap.sh` additions. The Neon role must be created **before** WP-S1a merges (`psql "$OWNER_URL" -tAc "select 1 from pg_roles where rolname='clinic_realtime'"` → `1`), and the `clinic-database-url-realtime` secret version added once WP-S1c's Terraform has created the container.
14. **($0 audit) Billing account type.** Is the billing account Paid or a Free Trial? A Free Trial needs a card, closes after 90 days unless upgraded (stopping every resource, then deleting them after 30 days), and pays any overage silently from the $300 credit. We recommend a Paid account (upgraded trial or existing) with the guards in §13.5. A card on file means an escaped overage is charged to it; that is why the spend cap, max-instances and `cost-check` exist, and why we read gross cost, not net (C17).
15. **($0 audit) Other projects on the billing account.** List them (C14). Free tiers for Cloud Run, Artifact Registry and Secret Manager are per billing account; if another project uses them, either move this project to its own billing account or recount §13 with that project's usage.
16. **($0 audit) Vercel Hobby terms.** Confirm the engineer is comfortable that an unpaid interview submission is "non-commercial personal use" under Vercel's fair-use guidelines (deduced, a judgment call).
17. **($0 audit) Spend cap.** Approval to create the $3 gross Cloud Run spend-cap budget, knowing it pauses Cloud Run (the API goes down) if it trips, and to confirm this billing account is eligible (spend caps are for first-party Google Cloud customers; Free Trial eligibility is unverified). **Added by §12.4:** the spend-cap page does not say whether Cloud Run network SKUs count toward the cap (read 2026-10-16); the engineer confirms in the console which SKUs the budget's cost scope includes, and we do not claim the cap bounds egress until then.
18. **($0 audit) Accounts with no card.** Confirm Neon, Vercel, CircleCI, Cloudflare and Docker Hub accounts stay on free plans with no payment method, so their limits pause instead of bill.
19. **($0 audit) Alert recipient.** The email address for the Cloud Monitoring notification channel and the budget alerts (the engineer's; not written into the repo).
20. **(§12.4) If the C19 gate ever fails** (CircleCI egress outside North America): accept the tag-URL smoke's few KB per release as a recorded breach of the $0 rule, or replace the pre-promotion smoke with a design that never calls the tag URL from CI. The executor never makes this call; until the engineer decides, the release stops before promotion.

---

# 12. Red-team disposition

Two red-team reviews (R1, R2) were applied in full. Where both raised the same point, it is merged into one row.

| # | Source | Severity | Issue | Resolution | Where |
|---|---|---|---|---|---|
| 1 | R1, R2 | major | Control test vacuous: with the index dropped and no pre-check, sequential requests also duplicate | **Applied.** Replaced with a lock-waiter sampler assertion (peak waiters ≥ 5 during the real run) and a naive check-then-insert control through the identical harness. §0 claim reworded | §0, §3.4, WP-08, ADR-0018 |
| 2 | R1 | major | Mandatory auth would 401 graders on the brief's endpoints | **Applied (option A).** No API auth in v1. IDOR documented (TD5). Layering path in ADR-0012. Demo tokens removed | AM-03, ADR-0012 |
| 3 | R1, R2 | major | Smoke depends on shared demo patients, the cap and a hard-coded slot | **Applied.** Fresh patients per run, dynamic doctor/date/slot selection, `try/finally` cleanup, 5-run acceptance. Cap dropped. README step 0 | WP-12, AM-19 |
| 4 | R1 | major | Over-scoped T2 reads as overkill | **Applied.** T2 reduced to the UI + codegen, idempotency and the security gates. SSE, auth, OAuth, chart, rate limit, cap and CAPTCHA moved to "deferred". Cut ranks rewritten. Hours-spent line added. *Partly reversed by the engineer's stretch decision (§12.1).* | §0, §8 cut line, §9 |
| 5 | R1, R2 | major | SSE complexity, cost (reconnect forever, Neon awake) and connection-holding DoS | **Applied.** SSE not built. Visible-only polling with an idle stop. ADR-0009 keeps the growth path and records the stream caps, reconnect idle stop, poller backoff, `from_local_date` routing and the Neon consumption check for when it lands. *Partly reversed: admin-only SSE is stretch S1 (§12.1).* | §3.7, ADR-0009 |
| 6 | R1 | major | Better Auth: fragile JWKS dependency, second DB, Google Testing-mode consent | **Applied.** Removed. Q4 and the auth DB dropped. OAuth/OIDC named as the production path. *Admin-only OAuth without Better Auth is stretch S3 (§12.1).* | ADR-0012 |
| 7 | R1, R2 | major | DB roles described but not wired; a single shared secret | **Applied.** Two roles, two secrets, per-SA accessor bindings, grants + default privileges in 0001, a role-precondition check, a DDL-denied test locally and on Neon | §5, WP-04, WP-11, ADR-0015 |
| 8 | R1 | major | Exact pins unverified | **Applied.** WP-00 added. 17 pins verified today against the registries. Found that `@hey-api/client-fetch` is deprecated and bundled since openapi-ts 0.73.0, so it is no longer installed separately. The remaining images, binaries and platform facts are WP-00 tasks. Lockfile is the source of truth | WP-00 |
| 9 | R1 | major | §11 credibility trap | **Applied.** The two decisions must predate or override AI output, with citations. Transcripts exported. A per-WP generated-code table. Engineer-only slots | ADR-0020, Q8, §9 |
| 10 | R1 | major | WP-10 user-gated and too late | **Applied.** Cloud set-up starts D1. A walking-skeleton deploy through the real WIF path by end of D2 (Gate A) | WP-11, schedule |
| 11 | R2 | blocker | `google.subject` must be ≤ 127 bytes; the CircleCI `sub` is longer | **Applied.** Subject = project-id + `:` + vcs-ref (about 52 bytes). Never `assertion.sub`. Binding via `attribute.project_id`. Fallback documented. Acceptance asserts the mapping | WP-11, ADR-0016 |
| 12 | R2 | blocker | Audience: the token `aud` = org id, so the exchange fails without `allowed_audiences` | **Applied.** `allowed_audiences = [org id]`; the redundant aud CEL check removed. Acceptance asserts it | WP-11, ADR-0016 |
| 13 | R2 | blocker | `--no-traffic` on a new service; deployer lacks `setIamPolicy` for public access | **Applied.** `bootstrap.sh` creates the service once and binds `allUsers` invoker. CI never passes `--allow-unauthenticated`. Unauthenticated-curl acceptance. (Superseded by the $0 audit: invoker bound to the proxy identity and `clinic-smoke` only, ADR-0023; the proxy identity is `clinic-web` since §12.3, superseding the draft name `clinic-frontdoor`.) | WP-11, ADR-0016 |
| 14 | R2 | major | `--to-latest` can promote an untested revision; concurrent migrations | **Applied.** Promote by tag. A single `ship-api` job under `serial-group`. Newer-commit guard. Alembic advisory lock | WP-12, ADR-0016 |
| 15 | R2 | major | Time-dependent acceptance ("tomorrow" = Sunday); SQL `now()` diverges from FakeClock | **Applied.** Fixed FakeClock on a Monday. `clock.now()` as a bind parameter. Extra banned APIs. Manual checks use "first date with slots" | global rule 9, §3.6, WP-07 |
| 16 | R2 | major | Deadlocks (40P01) on swaps mapped to 503; pool timeout to 500 | **Applied.** SQLSTATE map, one retry then 409 `CONCURRENT_UPDATE`. Pool and connection errors → 503. Race cases 7 and 8 | §5, WP-08, ADR-0008 |
| 17 | R2 | major | SQLAlchemy exception strings log bound parameters (PII) | **Applied.** `hide_parameters=True` plus a log test on a forced CHECK violation | WP-04, WP-07, ADR-0019 |
| 18 | R2, R1 | major / minor | Client-IP derivation for the rate limiter; limits too low | **Moot for v1** (rate limiting deferred). `--proxy-headers` removed now. ADR-0012 records the right-most-XFF rule, post-verification `sub` keying, OPTIONS exemption and a 60/min starting point for when it lands | ADR-0012, WP-03 |
| 19 | R2, R1 | major / minor | Attacker-editable config can attach secret contexts; tag pipelines run `pr` | **Applied.** Context expression restrictions (main only), an unrestricted empty `oidc-probe` context for the deny test, a context negative test, and `not: pipeline.git.tag` on both workflows | WP-10, WP-11, ADR-0016 |
| 20 | R2 | major | Migrations run before the smoke test; expand-only unenforced | **Applied (partly).** `migration-lint` gate added. N-1 compatibility test recorded as debt TD16 (no previous tag exists before v1.0.0) | WP-12, ADR-0015 |
| 21 | R1, R2 | minor | ZAP baseline after promote against Swagger HTML is theatre; DAST against prod data | **Applied.** `zap-api-scan.py` against the OpenAPI spec of an ephemeral compose stack in PR and release, before deploy. Exit 0/2 pass, 1/3 fail. No scan of prod | WP-13, ADR-0017 |
| 22 | R1, R2 | minor | Idempotency replay claims "original body"; key minted per retry in the UI | **Applied.** Current representation + header; 409 `IDEMPOTENCY_KEY_CONSUMED` if no longer booked. `useRef` key per dialog | AM-16, ADR-0013, WP-16 |
| 23 | R1 | minor | Inactive doctors unspecified | **Applied.** AM-23 + tests | §2, §6 |
| 24 | R1 | minor | Credit burn | **Applied.** Measure after WP-10; DAST is the only machine-executor job | WP-10 |
| 25 | R1 | minor | Repo visibility for CI evidence | **Applied.** Public before the first CI PR; Actions-on-public check recorded | Q3 |
| 26 | R1 | minor | Trivy may block the submission-day deploy | **Applied.** Runbook, dated ignore entries, digest freeze | WP-13 |
| 27 | R1 | minor | ADR region padding (domain mapping); free tier unchecked | **Applied.** Domain-mapping argument deleted. Free-tier check moved to WP-00. Latency stays labelled unmeasured | ADR-0014, WP-00 |
| 28 | R1 | minor | `gitleaks protect` deprecated | **Applied.** `gitleaks git --pre-commit --staged`, confirmed via `--help` in WP-00 | §7, WP-02 |
| 29 | R1 | minor | The harness filter tripped on a tooling-path example | **Applied.** Acceptance uses a neutral placeholder path | WP-01 |
| 30 | R2 | minor | Poller ignored `from_local_date` | **Moot** (SSE deferred). Recorded in ADR-0009 for when it lands | ADR-0009 |
| 31 | R2 | minor | Enumeration oracles (ownership order, phone exists) | Ownership order is **moot** (no auth). The phone oracle is **documented** as AM-25 / TD14 | §2, §10 |
| 32 | R2 | minor | JWKS refetch amplification, issuer confusion | **Moot** (Better Auth and JWT removed). Noted in ADR-0012 as requirements for the future auth work | ADR-0012 |
| 33 | R2 | minor | Conditional demo-token route makes OpenAPI env-dependent | **Applied.** The route is gone, and `export_openapi.py` uses fixed Settings with a `DATABASE_URL=bogus` determinism check | WP-09 |
| 34 | R2 | minor | `sh -c` as PID 1 swallows SIGTERM | **Applied.** `exec uvicorn ... --timeout-graceful-shutdown 8` + a shutdown-log acceptance | WP-03 |
| 35 | R2 | minor | `BaseHTTPMiddleware`/GZip vs streaming | **Applied.** Pure ASGI middleware, no GZip. The disconnect test moves to ADR-0009 with SSE | §7, WP-06 |
| 36 | R2 | minor | Lax int timestamps, local day bounds, DST fall-back, error precedence | **Applied.** Str-only `BeforeValidator`, UTC stepping + dedupe, fall-back and local-day-bound tests, TIMEZONE_REQUIRED-only-when-all rule | AM-02, WP-05, WP-06, WP-07 |
| 37 | R2 | minor | Acceptance criteria not mechanically checkable | **Applied.** In-test assertions with `-rA`, corrected WP-14 test paths, `up -d --wait`, `db` restarted in WP-06, T2 cells excluded, the SSE metric step dropped with SSE | WP-03..WP-14 |
| 38 | R2 | minor | Seed delete-and-reinsert risk; "recount" invites changing 27 | **Applied.** `ON CONFLICT DO UPDATE` only, a no-DELETE grep, 27 as a fixed value | §5, WP-04 |
| 39 | R1 | minor | Rate limiter must be off in tests | **Moot** (deferred). Recorded in ADR-0012 (`RATE_LIMIT_ENABLED`) | ADR-0012 |

**Rejected outright:** none. Every point was either applied or made moot by a scope reduction that another point demanded.

## 12.1 Post-red-team scope change: the gated stretch tier

After both red-team reviews were applied, the engineer decided to keep the lean core exactly as planned and add a gated stretch tier (S1-S4, §0). This partly reverses the scope reductions in rows 4, 5 and 6 and re-opens the items that rows 18, 30, 32, 35 and 39 had marked moot. It is a deliberate decision by the engineer, not a red-team outcome, and it is recorded here so the reversal is visible rather than silent.

Why the gate makes this safe:
- **The required scope is live before any stretch work starts.** Every required (T0/T1) endpoint is already live in prod and passes `verify_claims.py` before stretch work starts (Gate B, with a fixed deadline of Sun 18 Oct 23:59 EAT and pasted evidence). The remaining lean-core work (WP-13 to WP-18) runs alongside the stretch lane and always has priority (§8 stretch preamble rule 1).
- **Every item drops cleanly.** Items are independent, cut S4 → S1, all before any lean-core item (if a lean-core item is cut for time, every stretch item is already gone; only work that already shipped stays), with a hard 16:00 Wed cut-off. No stretch migration or role can fail a lean-core release (K35). An unshipped item becomes a "designed, not shipped" line in README §4.4, which is the same honest state the red-team asked for.
- **The required endpoints cannot change.** The preamble guards in §8 check, per PR, that the lean-core behaviour files and the app-wide files (`main.py`, middleware, CORS, problems, config, migrations env) are untouched or only added to, that existing OpenAPI operations and schemas are byte-identical, and they re-run Schemathesis locally and `verify_claims.py` against prod.
- **The red-team's specific objections are answered in the design, not waved away.** Row 5's cost and DoS concerns: streams live on a separate Cloud Run service (they cannot starve `POST /appointments`), poll only while clients exist, close on hidden tabs and after 10 minutes idle, and are capped per IP and per instance. Row 6's Better Auth coupling: replaced by direct Google ID-token verification in FastAPI against Google's JWKS, with no second database and no runtime dependency on the web app. Row 30's routing concern: events carry both `local_date` and `from_local_date`. The SSE ordering problem (an id- or time-based cursor skips rows that commit out of order): replaced by the xid8 snapshot-horizon cursor with an out-of-order-commit integration test and a naive-cursor control (§3.9, WP-S1b).
- **What we accept.** A second language and deploy unit (TD18), public admin aggregates until S3 (TD25), a bot check that direct API calls bypass (TD22), and reviewers being unable to sign in to `/admin` once S3 ships (K26).

| Earlier row | Earlier resolution | Now |
|---|---|---|
| 4 | SSE, auth, OAuth, chart, rate limit, cap and CAPTCHA deferred | Admin SSE + chart (S1), admin OAuth (S3) and a UI bot check (S4) are stretch; patient auth, rate limiting and the cap stay deferred |
| 5 | SSE not built | Admin-only SSE via a Go gateway as S1; patients keep polling |
| 6 | Better Auth removed | Still removed; admin OAuth is Auth.js in the web plus direct Google JWKS verification in the API (S3) |
| 18, 39 | Rate limiting moot | Still deferred; only the per-IP stream cap is built (S1) |
| 30 | `from_local_date` routing moot | Applies to S1 payloads (both dates carried) |
| 32 | JWKS amplification and issuer confusion moot | Applies to S3: pinned RS256, fixed issuer set, cached JWKS with single-flight and cooldown |
| 35 | Disconnect test moved to ADR-0009 | Lives in WP-S1b (subscriber count returns to 0) |

## 12.2 Stretch-tier review

A third review (R3) read the stretch tier against the lean core and against itself. Every blocker and major point is applied; minor points are applied where cheap, and none is rejected outright. Rows 19 and 36 raised the same point and are resolved together.

| # | Severity | Issue | Resolution | Where |
|---|---|---|---|---|
| 1 | blocker | `0003` needs `clinic_realtime`, but CI's `backend-test` (and possibly `dast`) creates only `clinic_app`, so every PR would go red after WP-S1a | **Applied.** WP-S1a owns `.circleci/config.yml`: `backend-test` runs `02-realtime-role.sql` after `01-roles.sql`, `dast` mounts the initdb directory; PR not mergeable until CI creates both roles; acceptance shows a lean-core-only PR green on `backend-test` and `dast` | §5 roles, WP-S1a, ADR-0015, ADR-0016 |
| 2 | major | Neon role creation had no ordering, so an early merge would fail `clinic-migrate` and block `ship-api` | **Applied.** Role creation on Neon is WP-S1a's first, tier E precondition with a `pg_roles` check; same line in Q13. The secret version moved to WP-S1c, after Terraform creates the container | WP-S1a, WP-S1c, Q13 |
| 3 | major | WP-14 and WP-S1a in parallel can leave two alembic heads | **Applied.** "One head, always" rule: WP-S1a rebases after WP-14 merges or is cut; `alembic heads \| wc -l` → `1` in acceptance and in `backend-quality`; risk K36 | §5 migration rules, WP-S1a, K36 |
| 4 | major | WP-S1a added all eight stretch codes without regenerating OpenAPI, the client or `errors.ts` | **Applied.** One owner per code (S1a: stream codes; S3: ADMIN_*; S4: BOT_CHECK_*), each WP regenerates `contracts/openapi.json` and `web/src/api/generated/**`, updates `errors.ts`, and runs the drift and build commands when `web/` exists | §6 stretch codes table, WP-S1a, WP-S3, WP-S4 |
| 5 | major | "All four drop before any lean-core item" contradicted by the knock-on rule keeping S1 alive after WP-15/16 are cut | **Applied (absolute rule kept).** Knock-on rule rewritten: if WP-15/16 are cut for time, S1 is already cut; if WP-16 is merely unmerged at Gate C after S1a-c shipped, they stay as shipped. Same wording in §0 and §12.1 | §0, §8 cut line, §12.1 |
| 6 | major | Go integration tests had no schema set-up, credentials or FK fixtures | **Applied.** WP-S1b states the local and CI set-up (roles, `alembic upgrade head` as owner, `cimg/python:3.12` primary with a checksum-verified Go), `RT_TEST_OWNER_URL` / `RT_TEST_REALTIME_URL`, fixtures, and what `make rt-test-int` runs | WP-S1b, ADR-0016, ADR-0018 |
| 7 | major | WP-S4 relied on a preview deploy that does not exist; bypass check had a placeholder body | **Applied.** Local `pnpm build && start` against compose with Cloudflare's test keys (values to confirm against their docs in the WP), pass then fail; the bypass is a complete script against prod with cleanup | WP-S4 |
| 8 | major | After S3 the realtime smoke could fall back to two 401s, leaving K21 (SSE buffering) unguarded; the token-creator grant was missing | **Applied.** Terraform adds `clinic-smoke` and the deployer's `serviceAccountTokenCreator` on that SA only, with a JWT `aud` acceptance. If minting cannot work, S3 is dropped rather than weakening the smoke. Recorded in K21 and ADR-0016 | WP-S3, K21, ADR-0016, ADR-0022, Q11 |
| 9 | major | Behaviour with S3 merged but `ADMIN_AUTH_ENABLED=false` undefined | **Applied.** `require_admin` is a no-op; `/admin/stream-ticket` returns 200 with a ticket; 401/403/503 declared unconditionally; both flag values tested; key generated per process when unset | §6 row 16, §7 config, WP-S3, ADR-0022 |
| 10 | minor | Components rule broke on `StreamTicket` and `securitySchemes`; no runnable check; "path guard" mislabelled | **Applied.** Schema renamed `AdminStreamTicket`; `securitySchemes` allowed; three runnable `jq` checks added; §6 says "contract guard (rule 3)" | §6, §8 preamble rule 3 |
| 11 | minor | initdb runs only on a fresh volume; `\d` output compared literally | **Applied.** `docker compose down -v` (or run the script manually) first; `\d` replaced by a `-tAc` query whose output `xid8\|t\|pg_current_xact_id()` was observed locally | WP-S1a |
| 12 | minor | No `0003` downgrade, so round-trip and `migration_lint` could not both pass | **Applied.** Downgrade specified in §5 with `# contract-ok: downgrade only` on the drop-column line | §5, WP-S1a |
| 13 | minor | WP-S1b criteria in prose; unspecified log lines and port | **Applied.** Exact per-IP loop command, `poller started` / `poller stopped` slog messages, compose `ports: ["8081:8080"]` and env | WP-S1b |
| 14 | minor | D5 gave WP-S4 time ahead of higher-priority work | **Applied.** WP-S4 runs on D5 only if WP-S1c's deploy is green and WP-S2 is underway, never delaying WP-S1d; same rule in the stretch parallel groups | §8 schedule, parallel groups |
| 15 | minor | `API_BASE_URL` attributed only to S4 | **Applied.** "(S3 and S4, server-only)"; whichever lands first adds it; listed in WP-S3's files. (Superseded by §12.3: the routes call `call-api.ts` in-process.) | §7 web config, WP-S3, WP-S4 |
| 16 | minor | RS256 needs the PyJWT crypto extra | **Applied.** `uv add 'pyjwt[crypto]==2.15.1'`; `cryptography` version recorded | WP-S3 |
| 17 | minor | next-auth v5 maintenance and pre-release status unexamined | **Applied.** Observed today: `latest` `4.24.15`, v5 only as `beta` `5.0.0-beta.32`. WP-S3's first step records dist-tags and maintenance status (the maintenance claim itself is the review's, unverified here); K34, TD27 | WP-S3, preamble rule 6, K34, TD27, ADR-0022 |
| 18 | minor | WP-S2 assumed the webpack wrapper | **Applied.** Files read "next.config.ts and/or the Serwist Turbopack route"; both `@serwist/next` and `@serwist/turbopack` exist (9.5.13, observed today); drop-S2 rule kept | WP-S2 |
| 19 | minor | ADR-0022 option 1 said the gateway trusts Google tokens | **Applied** (with row 36). Option 1 now makes FastAPI the single verifier and leaves the gateway to options 4 and 5 | ADR-0022 |
| 20 | minor | ADR-0021 promised two measurements no WP recorded | **Applied.** Image size in WP-S1b acceptance; Cloud Run memory utilization in WP-S1c | WP-S1b, WP-S1c, ADR-0021 |
| 21 | minor | ADR-0001's "neither directory exists" false after WP-S1a | **Applied.** Reworded; schema file and stream codes added to TD24 and cut line S-4 | ADR-0001, TD24, §8 cut line |
| 22 | minor | PWA acceptance sat under the Theme bullet; §3.7 title outdated | **Applied.** Sentence moved under PWA; §3.7 is "Freshness in the patient UI (polling; no push for patients)". No document linked the old anchor (checked with `rg '#37'`) | ADR-0010, §3.7 |
| 23 | minor | Verification note: lean-core diff reconstructed from transcripts | **No change needed.** A baseline copy of `docs/` was taken before this pass, so this pass's lean-core diff was checked against a file, not a transcript | n/a |
| 24 | major | §12.1 claimed the lean core is finished before stretch starts; the schedule says otherwise | **Applied.** Reworded: required T0/T1 endpoints are live and pass `verify_claims.py`; WP-13 to WP-18 continue alongside with priority. Same wording added to §0 | §0, §12.1 |
| 25 | major | Gate B had no deadline, no evidence and no definition of "red" | **Applied.** Passed by Sun 18 Oct 23:59 EAT, `verify_claims.py` all PASS from an unauthenticated machine plus a green `main`, evidence in `docs/evidence/gate-b.txt`, no re-entry if missed. "Red" = `main` failing or a lean-core WP not merged by the end of its day, checked at the start of each stretch session | §0, §8 rule 1, D3 row, §7 tree |
| 26 | major | `0003` raising on a missing role inside `ship-api` lets a stretch role block core releases | **Applied (option b).** `0003` adds column and index unconditionally and skips the grants with a NOTICE; the runbook re-applies the grants idempotently; role creation is still a merge precondition; risk K35. A pre-migrate `pg_roles` check in `ship-api` was **not** adopted: CircleCI never holds DB credentials (WP-12 "Do not") | §5, WP-S1a, K35, ADR-0015 |
| 27 | major | Same-transaction test was a tautology (a column default always fires in the inserting transaction) and could fail falsely under savepoints | **Applied.** Primary check joins the latest event per appointment and asserts `e.xmin = a.xmin`; negative test makes the event insert raise (monkeypatched in the test) and asserts neither row exists; the low-32-bit check is secondary and dropped if savepoints are used | WP-S1a, §3.9, ADR-0018 |
| 28 | major | LISTEN rejection self-contradictory (the gateway already holds a direct pool); "Neon can suspend" was a deduction | **Applied.** Rejection rewritten on lossiness, booking-path change, global commit lock and a session held with zero clients. The pool is now closed at zero subscribers (`MaxConnIdleTime` 60 s in between); suspend-after-last-viewer is labelled unverified and measured in WP-S1c (K24) | §3.9, WP-S1b, WP-S1c, K24, ADR-0009, ADR-0021, §7 config |
| 29 | major | ADR-0022 said reCAPTCHA lacks single-use replay protection | **Applied.** Corrected: both providers' tokens are single-use. Turnstile chosen for no score tuning, lighter privacy and consent position, and cost | ADR-0022 |
| 30 | major | "Navigations network-first" caches HTML (including `/admin`) and `defaultCache` presets are `NetworkFirst`; test too weak; RSC not listed | **Applied.** Navigations `NetworkOnly` with a catch handler to the precached offline page; no `defaultCache`; RSC, `/api/auth/*` and `/admin/**` network-only; first-match test asserting no `NetworkFirst`/`CacheFirst`/`StaleWhileRevalidate` on any sample | WP-S2, K28, ADR-0010 |
| 31 | major | Path guard ignored app-wide files (`main.py`, middleware, CORS, problems, config, migrations) | **Applied.** Untouched list for middleware, CORS, problems and `migrations/env.py`; additive-only for `main.py` and `config.py`; `main.py` may only add the admin router; migrations new files only. `.paths` diff already covers existing `responses`; rule 4 notes Schemathesis runs over existing paths | §8 preamble rules 2-4, §12.1 |
| 32 | minor | Horizon stall sources and lag measurement missing; Neon behaviour unverified | **Applied.** Idle-in-transaction timeouts on every login role; `max_prepared_transactions` checked on Neon (local PG 17 shows `0`); per-tick lag log via `pg_snapshot_xmax - pg_snapshot_xmin` (assigns no xid) with WARN above 10 s; tier E Neon run of the gateway query and `pg_snapshot_xmin` | §3.9, §5 roles, WP-S1a, WP-S1b, K23 |
| 33 | minor | Fast-default question left "unverified" | **Applied and verified locally.** `provolatile = 's'`; filenode unchanged and `atthasmissing = t` after the ALTER on PG 17.11; comment rewritten; `0003` sets `lock_timeout = '5s'` (there was no existing migration lock_timeout to inherit) | §5 `0003`, §3.9, WP-S1a |
| 34 | minor | Native EventSource auto-reconnect could double streams; expired id_token stalls silently | **Applied.** `es.close()` before every reopen; ticket 401 redirects to sign-in; `admin/layout.tsx` forces re-auth near token expiry; tests for one live EventSource | WP-S1d, WP-S3, §3.10 |
| 35 | minor | `jti` implied single use that nothing enforced | **Applied.** `jti` removed; ticket stated as reusable within 60 s TTL; TD21 updated | §6 row 16, WP-S3, §3.10, TD21, ADR-0022 |
| 36 | minor | Same as 19, plus "`aud` is not a trust boundary" | **Applied.** Option 1 reworded; ADR-0022 and §3.10 state that `email_verified` plus the allowlist is the real gate | ADR-0022, §3.10 |
| 37 | minor | "$0" for an open stream was an estimate without arithmetic | **Applied.** ADR-0014 now carries vCPU-seconds per connected hour, the shared free allowance (list figures, to confirm) and the hourly cost above it, labelled a deduction; WP-S1c compares measured billed vCPU-seconds. `--cpu 0.5` **rejected**: below one vCPU Cloud Run requires concurrency 1 (per its docs, to be confirmed in WP-S1c), which would make every stream its own instance | ADR-0014, WP-S1c |
| 38 | minor | Vercel default region, missing `hostname`/`action` checks, and loss of codegen coverage on the UI write | **Applied.** `preferredRegion = "fra1"` on the S4 route and `/admin/api/*` (superseded by the $0 audit: project-wide `iad1`, §3.10, §13.6); `hostname` and `action` checked; forwarded body parsed with the generated zod schema | §3.10, §7 web config, WP-S3, WP-S4, ADR-0022 |
| 39 | minor | Event id comparison unspecified | **Applied.** `Set` dedupe; `BigInt` tuple order; unit case `"9.5"` before `"10.1"` | §6 row 17, WP-S1d |
| 40 | minor | `verify_stream.py` resume check fails falsely if anyone else writes | **Applied.** Assertions filter on the smoke's own `doctor_id` and slot and ignore unrelated events | WP-S1c |
| 41 | minor | Panel lens: S2-S4 read as scope creep; S3 hides S1 from reviewers | **Applied within the user's order and gate.** README §4.4 opens with the Gate B timestamp and lists only what shipped; S3 evidence is a recording plus `verify_stream.py` output and the two 401 curls, with reviewer allowlisting offered; the S1 brief line keeps only the Section 1 trade-offs citation (the "staff view" citation is dropped). The stretch items and their order are the engineer's decision and are not re-litigated | §0 stretch table, §9 |

## 12.3 Engineer's hosting decision: Vercel for the frontend, GCP for the backend

Decided by the engineer on 2026-10-16. It answers Q5 with ADR-0023 option 1 and adopts one simplification now; it is recorded here and in [ADR-0023](../adr/0023-zero-cost-edge-front-door.md) and is not re-litigated.

- **What.** Vercel hosts the frontend and GCP hosts the backend: Cloud Run `clinic-api` (and `clinic-realtime` with S1) in us-east4, IAM-only; Neon aws-us-east-1; Vercel functions in iad1. There is **one Vercel project**, the Next.js app in `web/` (`clinic-web`). The front door is a set of route handlers inside it: `web/src/app/api/[...path]/route.ts` proxies to Cloud Run with a Google ID token minted via Vercel OIDC → GCP WIF, and `/docs`, `/redoc` and `/openapi.json` proxy the API's documentation, so reviewers open Swagger at the Vercel URL.
- **Why.** One Vercel project, one deploy, one OIDC trust, fewer moving parts.
- **Scope.** The proxy route handlers and a minimal landing page linking to Swagger are **lean core**: they are the public URL the brief requires. WP-11 Part C builds them by end of D2, so they are live for Gate A and in place for Gate B. The booking UI pages stay T2 (WP-15, WP-16, cut first); the admin dashboard, PWA, OAuth and Turnstile stay stretch. Cutting the UI pages removes neither the proxy nor the landing page nor `ship-web`, so the public URL survives every cut (§8 cut line).
- **What we accept.** The public REST base gains an `/api` prefix (paths below it are unchanged); S3's Auth.js moves to `/auth/*` and S4's route to `/ui/appointments`, because `/api/*` belongs to the proxy (K47); the proxied `/openapi.json` carries `servers: [{"url": "/api"}]`; ~~the doc routes are CDN-cached for 10 minutes, so Swagger can show the previous contract for up to 10 minutes after an API release;~~ the doc routes are static, built from the committed contract of the same release (§12.4), so Swagger shows exactly the deployed contract and never costs Cloud Run egress; the web lane, `ship-web` and `VERCEL_TOKEN` (TD7) become lean core. In return the UI and Swagger are same-origin with the API.

**Rename map (superseded names, kept for the record).**

| Superseded (first $0 draft) | Now |
|---|---|
| Vercel project `clinic-frontdoor`, directory `frontdoor/` | the `web/` project, `clinic-web` |
| `frontdoor/src/app/[[...path]]/route.ts` | `web/src/app/api/[...path]/route.ts` and `web/src/app/{docs,redoc,openapi.json}/route.ts` |
| `frontdoor/src/lib/*`, `frontdoor/tests/*`, `frontdoor/vercel.json` | `web/src/lib/proxy/*`, `web/tests/proxy/*`, `web/vercel.json` |
| service account `clinic-frontdoor@<project>` | `clinic-web@<project>` |
| WIF condition `project:clinic-frontdoor:environment:production` | `project:clinic-web:environment:production` |
| CircleCI `frontdoor-quality`, `ship-frontdoor` | `web-quality`, `ship-web` (both lean core, WP-11 Part C) |
| `TRUST_FRONTDOOR_CLIENT_IP` | `TRUST_PROXY_CLIENT_IP` |
| public base `https://<clinic-frontdoor>.vercel.app` | `https://<clinic-web>.vercel.app/api`, docs at the origin root |
| `API_BASE_URL` for the S3/S4 server routes | in-process `web/src/lib/proxy/call-api.ts` |
| `/api/appointments` (S4), `/api/auth/*` (S3), doctor list at `/` | `/ui/appointments`, `/auth/*`, doctor list at `/doctors` (`/` is the landing page) |

**Cost verifier findings applied in the same pass (2026-10-16).**

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | The kill switch removed the proxy's invoker binding from `clinic-api` only | Same removal for `clinic-realtime`; both commands in ADR-0023 and the runbook | ADR-0023, §13.6, WP-11, K40 |
| 2 | Public access can return without `allUsers` (`--no-invoker-iam-check` / `run.googleapis.com/invoker-iam-disabled`, `--allow-unauthenticated`) | Both banned in `cost-static` and rule 11; C2 asserts the annotation absent or false; C3 added to `--live` | §8 rule 11, WP-12a, C2, C3 |
| 3 | No guard for always-allocated CPU, VPC egress, GPUs or service-level min instances | Static ban; C1 prints `cpu-throttling` and service-level `minScale` | rule 11, WP-12a, C1 |
| 4 | Rule 8 plan grep missed static IPs, VPC connectors, VMs, GKE, serverless NEGs, backend services, remote repositories, user-managed replication | Patterns added | §8 rule 8 |
| 5 | Artifact Registry internet egress is billed from byte 0 | Egress row in §13.2; rule 11 bans pulls outside Cloud Run; `cost-static` check | §13.2, rule 11, WP-12a |
| 6 | BuildKit provenance/SBOM attestations add versions per push (deduced), breaking keep-2 and C6 | `--provenance=false --sbom=false`, asserted in `cost-static`; WP-12 checks one push = one version | WP-13, WP-12a, WP-12 |
| 7 | IAM-denied requests are free but still write request logs (deduced); past 50 GiB ingestion is $0.50/GiB | Free `_Default` exclusion `drop-iam-403`; C18 relaxed; residual K48 (widened to 401 and 403 as `drop-iam-denied` by §12.4) | WP-11, C18, §13.6, K48 |
| 8 | Alerting charges start no sooner than 2027-09-01 at $0.35 per metric reference a month | Delete or re-audit before 2027-08-01 | §13.6, WP-11, ADR-0014 review trigger |
| 9 | Cloud Run jobs bill a 1-minute minimum; §13 used 30 s per migrate run | 600 vCPU-s, 300 GiB-s | §13.2, §13.7 |
| 10 | State bucket row omitted egress and soft-delete billing; Vercel row omitted 1M CDN requests | Rows fixed; `--soft-delete-duration=0` required | §13.2 |
| 11 | W4 assumed 4 KB per Swagger request, but `/openapi.json` is tens of KB and was uncached | Doc routes `s-maxage=600`; WP-12 measures the size; egress recomputed (superseded by §12.4: the cache could be bypassed with a random query, so the doc routes are now static and never reach Cloud Run) | WP-11 Part C, §13.4, WP-12 |
| stale | ADR-0014 kept the africa-south1 → Frankfurt latency paragraph unmarked | Labelled superseded | ADR-0014 |

## 12.4 Hosting lock review

A review of the locked hosting model (§12.3) read the plan for anything that could still put a non-zero line on an invoice, or stop a less experienced executor. The hosting decision itself, Vercel for the frontend and GCP for the backend in one Vercel project, is the engineer's and is not re-litigated; every change below works inside it. One blocker and ten majors are applied; every minor is applied except where the row says otherwise. The review's documentation reads that we re-read on 2026-10-16 are marked "re-read"; the rest are the review's own reads or deductions and are labelled so.

| # | Severity | Issue | Resolution | Where |
|---|---|---|---|---|
| 1 | major | The `s-maxage=600` doc-route cache can be bypassed with a random query string (the CDN cache key includes it, deduced), so `/openapi.json?x=<random>` reached Cloud Run every time: about 9,000 requests to 1 GiB, not 165,000 | **Applied.** `/docs`, `/redoc` and `/openapi.json` are `force-static` route handlers built from the committed `contracts/openapi.json` (kept fresh by a new lean-core check in `backend-quality`); they never fetch from Cloud Run. `/api/docs`, `/api/redoc`, `/api/openapi.json` answer 308. Tests: zero upstream calls with a random query; acceptance: no Cloud Run log line for `/openapi.json`. K40 and §13.6 recomputed against the largest response a client can trigger uncached (about 12,000 requests, deduced). Swagger also no longer lags a release by 10 minutes | §0, §3.1, §3.2, §6 row 14, §7, WP-09, WP-11 Part C, WP-12, WP-12a, K40, §13.2, §13.4, §13.6, ADR-0023 |
| 2 | major | `drop-iam-403` matched only 403; a junk bearer gets a 401 (troubleshooting page, re-read) and its request log was still ingested | **Applied.** Exclusion renamed `drop-iam-denied`, filter `(httpRequest.status=401 OR httpRequest.status=403)` with the `logName` clause kept; C3 also sends a junk bearer and expects 401; C18, K48, §13.6, ADR-0014 updated | WP-11, C3, C18, K48, §13.2, §13.5, §13.6, §13.7, ADR-0014 |
| 3 | major | W1 was not the adversarial bound: the idle close is client-side and any caller gets a ticket before S3, so 2 streams × 720 h = 1,296,000 vCPU-s, bounded only by the lagging spend cap, which may not count network SKUs (spend-cap page, re-read: it does not say) | **Applied (server-side guard).** Tickets are required from S1 on, and `POST /admin/stream-ticket` (moved from S3 to S1) debits 700 s per ticket from a 345,600 s monthly budget in `stream_budget` (migration `0004`, written by `clinic-api`; the gateway stays read-only); exhausted → 503 `STREAM_BUDGET_EXHAUSTED`, click-to-refresh metrics. Worst case $2.49 gross, $0.51 under the cap, cap $2.22 under the $5.22 discount. Third residual stated (K49). The alternative, keep S1 cut unless S3 ships, was not chosen because it ties the most likely stretch item to the least likely one. The 700 s debit over-counts an honest stream (TD31) | §0, §3.9, §3.10, §5, §6 rows 16-17, §7, WP-S1a, WP-S1b, WP-S1c, WP-S1d, WP-S3, K24, K41, K49, TD31, §13.2, §13.4, §13.6, ADR-0009, ADR-0022 |
| 4 | major | Manual scaling (`--scaling`, `scalingMode`, `manualInstanceCount`), `services replace` and worker pools were not banned, and C1 would PASS a manually scaled service | **Applied.** Flag, annotation, YAML-replace and worker-pool bans in rule 11 and `cost-static`; C1 prints `metadata.annotations["run.googleapis.com/scalingMode"] // "automatic"` and expects `automatic`. The flag, annotation names and their placement under the service's `metadata` were re-read on the manual-scaling page | rule 11, WP-00 (j), WP-12a, C1, K50, §13.5, §13.6 |
| 5 | major | The pre-promotion smoke calls the tag URL from CircleCI; if CircleCI's egress is outside North America that is billed from byte 0, and C19 only recorded it | **Applied.** C19 is now a gate in `ship-api` (and `ship-realtime`) before any tag-URL call: not `US` → the job fails, nothing is requested or promoted, and the engineer decides (Q20). WP-00 (l) settles the location from CircleCI's docs (re-read: job machines run in AWS us-east-1/2 and GCP us-east1/us-central1); the egress address itself stays deduced, which is why the gate stays | WP-00, WP-12 step 5, WP-S1c, C19, Q20, §3.2, §3.8, §13.2 |
| 6 | minor | ADR-0014 said the alert policy is "free until 2027-09-01" | **Applied.** "free until at least 2027-09-01; delete or re-audit before 2027-08-01" | ADR-0014 |
| 7 | minor | Vercel memory marked UNVERIFIED | **Applied.** Re-read vercel.com/docs/functions/limitations (last updated 2026-08-24): Hobby 2 GB / 1 vCPU default and maximum; 300 s default and maximum, including streamed responses. WP-00 (f)'s memory item dropped. Noted that Fluid compute shares instances, so GB-h is bounded here by the stream count (at most 2), not per stream | §13.1, §13.2, WP-00 (f) |
| 8 | minor | §13.4 CircleCI line still said 22,200 / 26% without the 21,500 recomputation; the egress verdict rested on the cacheable-docs assumption | **Applied.** "(conservative ceiling; §13.3 computes 21,500)" in §13.2 and §13.4; egress verdict recomputed without doc-route fetches and with stream polls at the budget bound: about 655 MB, 39% headroom | §13.2, §13.4 |
| 9 | minor | The same-region Artifact Registry pull at $0 (WP-00 (i)) gated nothing | **Applied.** WP-00 (i) is a precondition of WP-12's first deploy, citing the pricing page's "Network" section; fallback: C17 shows no Artifact Registry egress line 48 h after the first release before any further release | WP-00 (i), WP-12, §13.2 |
| 10 | blocker | `vercel pull --yes` in CI had no project link (`.vercel/` is gitignored and `vercel-prod` held only `VERCEL_TOKEN`), so it would fail or link a project named `web`, whose OIDC `sub` fails the WIF condition; no WP held the Vercel bootstrap | **Applied.** New tier-E WP-11 Part C0: `vercel project add clinic-web`, issuer mode Team, Root Directory empty (CI uses `--cwd web`), every §7 env var with `vercel env add`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` (identifiers, from a local `vercel link`) added to `vercel-prod`. Acceptance: `vercel env ls production`, `/api/healthz` 200 through the exact-`sub` WIF condition, and a probe-project token rejected by STS. The `sub` format was re-read in Vercel's OIDC reference | WP-11 Part C0, §7 web config, Q2, Q4, ADR-0016 |
| 11 | major | Part C (D2) required "Try it out" on `GET /doctors`, but the prod schema and seed arrive with WP-12's first migrate (D3) | **Applied.** Part C checks `GET /healthz` through `$PUBLIC_API`; the `/doctors` check (3 doctors) moved to WP-12's acceptance | WP-11 Part C, WP-12 |
| 12 | major | No automated check ever exercised the public path; a broken proxy shipped green | **Applied.** Lean-core release job `smoke-public` after `ship-web`, no context and no credentials: Part C's curls (healthz, `servers[0].url == "/api"`, `/docs` 200, run.app 403), extended by WP-12 with `verify_claims.py --base-url "$PUBLIC_API"`. In §3.8, WP-12 acceptance and the never-cut list; its Cloud Run egress goes to Vercel `iad1` | §0, §3.2, §3.8, WP-11 Part C, WP-12, cut line, K51, §13.3, §13.4 W5 |
| 13 | major | The API's root-relative `Location` passed through unchanged, so at the public origin it resolved outside `/api/*` | **Applied (option a).** The proxy rewrites a `Location` starting with `/` to `/api` + value; `location.test.ts`; `verify_claims.py` asserts `GET urljoin(base, Location)` → 200. The contract and the compose path are unchanged | §6, WP-11 Part C, WP-12, ADR-0023 |
| 14 | major | The token exchange was not concrete: no STS request, an undefined `<pool>`, an ambiguous fallback, no rule on where `getVercelOidcToken()` runs | **Applied.** Exact STS form fields and `generateIdToken` call written in WP-11 Part C and ADR-0023; principal written in full; fallback is `roles/iam.workloadIdentityUser` (a superset that includes `getOpenIdToken`, per the review's `gcloud iam roles describe`) for the same single call, no second hop; `getVercelOidcToken()` inside the handler and never cached (re-read: the OIDC reference says it cannot run at module level and "Don't cache the returned token"); only the Google ID token is cached; negative test with a probe project | WP-11 Terraform scope, WP-11 Parts C0 and C, K38, ADR-0023 |
| 15 | major | WP-S3 and WP-S1c prod checks targeted direct run.app hosts, which answer 403 from IAM before the app runs | **Applied.** Rewritten against `$PUBLIC_API` (`/admin/metrics`, `/admin/stream-ticket`, `/stream` → 401; `verify_claims.py`); the direct-host `verify_stream.py` run struck; one direct check per service (run.app → 403); `ship-realtime`'s smoke uses `$PUBLIC_API` for the API side | WP-S1c, WP-S3 |
| 16 | minor | §3.10 still argued for a direct stream; WP-S1b still keyed on the right-most `X-Forwarded-For` | **Applied.** §3.10 paragraph marked superseded in place with the amended rationale; WP-S1b keys on `X-Client-IP` when `TRUST_PROXY_CLIENT_IP=true`, else `RemoteAddr`, with Go unit tests for both; `TRUST_CLOUD_RUN_XFF` struck in §7 and the compose env; K33 updated | §3.10, §7, WP-S1b, K33 |
| 17 | minor | Inconsistent public-base placeholders (`<prod>`, `https://<prod>`, `<prod api>`, `<web>`) | **Applied.** §6 defines `WEB` and `PUBLIC_API`; Gate B, Part B/C, WP-12, WP-18, preamble rule 4, WP-S1c, WP-S2, WP-S3, WP-S4, §9 and Q11 use `$WEB` / `$PUBLIC_API`; Gate B states it must use `$PUBLIC_API` | §0, §6, §8, §9, Q11 |
| 18 | minor | Proxy header handling omitted `Host` and the decompression headers; the cache check used a HEAD | **Applied.** Request `host`, `connection`, `content-length` and the hop-by-hop set dropped; response `content-encoding`, `content-length`, `transfer-encoding` dropped; a gzip upstream test. The HEAD cache check is moot (static routes); replaced by the static route table and a Cloud Run log query | WP-11 Part C, ADR-0023 |
| 19 | minor | Swagger through the proxy assumed FastAPI's default doc URLs, and `/api/docs` bypassed the cache | **Applied.** WP-03 fixes `FastAPI(root_path="", openapi_url="/openapi.json", docs_url="/docs", redoc_url="/redoc")` with a test; the catch-all 308-redirects the three `/api/*` doc paths; `docs-routes.test.ts` covers it | WP-03, WP-11 Part C, §6 row 14 |

**Debt incurred by this review, stated:** TD31 (the 700 s debit over-counts an honest stream, so a real dashboard gets about 40 connected hours a month) and TD32 (the static docs pages load Swagger UI and ReDoc from jsdelivr). **Still deduced, not observed:** that Vercel's CDN key includes the query string (moot now), that a Cloud Run 401 is as unbilled as a 403, that CircleCI's egress address is in the US (gated per release), the 45 KB largest-response figure (WP-12 measures it), and that the spend cap counts network SKUs (Q17).

---

# 13. Cost: $0 proof

Added 2026-10-16 by the cost audit. The engineer's rule for this submission is that **total cost is $0**: not low, zero. Every resource below sits inside a documented free tier with headroom, with a hard cap where the platform offers one. Anything we could not prove $0 from an official page was changed or cut (§13.6).

**Evidence levels.** **VERIFIED** means read in the official pricing or free-tier document, or in the Cloud Billing Catalog API, on 2026-10-16 (by the cost audit, or while writing this section; the sources are listed per row). **DEDUCED** means arithmetic or reasoning from verified figures and our own usage estimates; nothing deduced is presented as observed. **UNVERIFIED** names the work package that settles it. Usage numbers are estimates until the README replaces them with observed values (C17 and the WP-S1c measurements).

**Regions, after the audit.** Cloud Run, its job and Artifact Registry in `us-east4`; Terraform state in `us-east1`; Neon `aws-us-east-1`; Vercel functions `iad1` in one project, `web` (§12.3); Secret Manager automatic replication. Why: ADR-0014 and ADR-0023.

## 13.1 Sources read on 2026-10-16

| Source | What it settles |
|---|---|
| https://cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus (Cloud Billing Catalog API, Cloud Run) | Tier 1 vs Tier 2 region lists and prices; the only free egress SKU is North America to North America (first 1 GiB); Africa, Europe and intercontinental egress priced from byte 0; first 2M requests free; jobs pricing in us-east4 |
| https://cloud.google.com/run/pricing | Free tier 180,000 vCPU-s, 360,000 GiB-s, 2M requests per billing account, applied as a spend-based discount at Tier 1 prices; jobs free tier 240,000 vCPU-s and 450,000 GiB-s; IAM-denied requests not billed; idle non-min instances not billed |
| https://docs.cloud.google.com/run/docs/authenticating/service-to-service | `X-Serverless-Authorization` is checked instead of `Authorization` when both are sent |
| https://cloud.google.com/run/docs/configuring/max-instances | max-instances can be exceeded briefly during spikes |
| https://cloud.google.com/artifact-registry/pricing ; https://cloud.google.com/artifact-registry/docs/repositories/cleanup-policy-overview | 0.5 GiB free per billing account, then $0.10/GiB-month; cleanup takes effect within about a day |
| https://cloud.google.com/secret-manager/pricing | 6 active versions (enabled or disabled), 10,000 access operations, 3 rotation notifications free per billing account; automatic replication billed as one location |
| https://cloud.google.com/storage/pricing | Always Free 5 GB-months Standard, 5,000 Class A, 50,000 Class B, only in us-west1, us-central1, us-east1 |
| https://cloud.google.com/free/docs/free-cloud-features ; https://cloud.google.com/stackdriver/pricing | Billing account required for free tiers; Free Trial terms; 50 GiB logs per project; non-chargeable metrics free; alerting charges no sooner than 2027-09-01 |
| https://cloud.google.com/billing/docs/how-to/budgets ; https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps | Alerts-only budgets do not cap; spend caps exist for Cloud Run, per project and service, gross cost, not instant |
| https://cloud.google.com/iam/pricing | IAM API use is free |
| https://neon.com/pricing ; https://neon.com/docs/introduction/plans ; https://neon.com/docs/introduction/regions | Free: no card, 100 CU-hours per project, 1 GB storage, 5 GB egress, suspends at limits; aws-us-east-1 exists, no Free-plan region restriction stated |
| https://vercel.com/docs/plans/hobby ; https://vercel.com/docs/functions/configuring-functions/region ; https://vercel.com/docs/limits/fair-use-guidelines ; https://vercel.com/docs/oidc/gcp | Hobby limits and pause-not-bill; single function region, default iad1; non-commercial use; OIDC federation to GCP on all plans |
| https://vercel.com/docs/caching/cdn-cache | Function responses with `s-maxage` are cached on Vercel's CDN, segmented by region; `x-vercel-cache` reports HIT/MISS (read for §12.3) |
| https://docs.cloud.google.com/run/docs/securing/managing-access | `--no-invoker-iam-check` and the `run.googleapis.com/invoker-iam-disabled` service annotation make a service public without `allUsers`; `--allow-unauthenticated` binds `allUsers` (read for §12.3) |
| https://vercel.com/docs/functions/limitations (last updated 2026-08-24) | Hobby function memory 2 GB / 1 vCPU default and maximum; duration 300 s default and maximum, "including streamed responses" (read for §12.4) |
| https://vercel.com/docs/oidc/reference (last updated 2026-09-17) | Team issuer `https://oidc.vercel.com/<team>`, audience `https://vercel.com/<team>`, `sub` = `owner:<team>:project:<name>:environment:<env>`; `getVercelOidcToken()` cannot run at module level and its result must not be cached (read for §12.4) |
| https://docs.cloud.google.com/run/docs/troubleshooting (last updated 2026-10-13) | 401 for an invalid, malformed, multiple or wrong-audience JWT; 403 for a missing token or missing `run.routes.invoke` (read for §12.4) |
| https://docs.cloud.google.com/run/docs/configuring/services/manual-scaling | `--scaling=<N>` and the `run.googleapis.com/scalingMode` / `manualInstanceCount` service annotations; idle manual instances "billed as idle minimum instances" under request-based billing (read for §12.4) |
| https://circleci.com/docs/guides/security/ip-ranges/ (last updated 2026-09-28) | Job machines run on AWS us-east-1 / us-east-2 and GCP us-east1 / us-central1 (read for §12.4) |
| https://circleci.com/pricing/ ; https://circleci.com/pricing/price-list/ ; https://circleci.com/docs/guides/plans-pricing/credits/ | 30,000 credits, no card, per-class rates, DLC 200 credits per job, blocked not billed at exhaustion |
| https://developers.cloudflare.com/turnstile/plans/ | Free, unlimited challenges and verifications |
| https://docs.docker.com/docker-hub/usage/ ; https://docs.github.com/en/billing/concepts/product-billing/github-packages | Docker Hub pull limits; GHCR public packages free |

## 13.2 Per-resource proof

Usage is the worst-case month of §13.4. Headroom = 1 − usage ÷ free limit.

| Resource | Planned usage, worst-case month | Free limit | Headroom | Hard cap mechanism | Source | Evidence |
|---|---|---|---|---|---|---|
| Cloud Run services CPU (`clinic-api` 1 vCPU, `clinic-realtime` 0.25 vCPU, us-east4) | ~~58,400 vCPU-s (api 8,000; realtime 50,400)~~ 94,400 vCPU-s (api 8,000; realtime at most 86,400, bounded by the stream budget, §12.4) | 180,000 vCPU-s per billing account | ~~68%~~ 52% | max-instances 3 / 2; timeouts 60 s / 300 s; stream budget 345,600 connected s a month; automatic scaling only (C1); spend cap $3 gross; IAM gating | run/pricing; catalog | limit VERIFIED; usage DEDUCED |
| Cloud Run services memory | ~~54,400~~ 90,400 GiB-s (api 4,000; realtime at most 86,400, §12.4) | 360,000 GiB-s | ~~85%~~ 75% | same | run/pricing | limit VERIFIED; usage DEDUCED |
| Cloud Run requests | ~~22,700~~ 24,400 (§12.4: + `smoke-public`, ticket and budget-bounded stream traffic; doc routes no longer reach Cloud Run) | 2,000,000 | 98.8% | IAM-denied requests not billed | catalog SKU "Requests" | VERIFIED; usage DEDUCED |
| Cloud Run job `clinic-migrate` | 10 executions × 60 s billed × 1 vCPU = 600 vCPU-s; 300 GiB-s at 0.5 GiB (~~30 s per run, 300 vCPU-s, 150 GiB-s~~: jobs bill a 1-minute minimum per execution, verified by the cost verifier on run/pricing) | 240,000 vCPU-s; 450,000 GiB-s (separate from services) | > 99% | `--task-timeout 600s --max-retries 0` | run/pricing | VERIFIED; usage DEDUCED |
| Cloud Run internet egress (to Vercel iad1, Neon aws-us-east-1, CircleCI) | ~~about 550 MB~~ about 655 MB (recomputed by §12.4: doc routes removed, stream polls at the budget bound, `smoke-public` added) | 1 GiB North America to North America; every other destination billed from byte 0 | about 39% | No `allUsers` invoker and no `--allow-unauthenticated` / `--no-invoker-iam-check` (C2), so nothing outside the proxy gets a response body; doc routes static (never Cloud Run); `smoke-public` traffic goes Cloud Run → Vercel `iad1`; daily alert at 30 MB; kill switch; the spend cap bounds it only if it counts network SKUs (unverified, Q17) | catalog SKU `DDFD-AE42-E219`; circleci.com/docs/guides/security/ip-ranges | limit VERIFIED; usage DEDUCED; ~~CircleCI's location UNVERIFIED (C19)~~ CircleCI job regions VERIFIED as US (documented); its egress address DEDUCED to be in the US and gated per release (C19) |
| Artifact Registry `clinic` (us-east4) | ≤ 2 versions per package: api ≤ 300 MB (shared base layers stored once, deduced), realtime ≤ 30 MB | 0.5 GiB (536.9 MB) per billing account | ≥ 38%; asserted below 400 MB | none from the platform; cleanup policy + CI prune + `cost-check` | artifact-registry/pricing | limit VERIFIED; sizes DEDUCED (measured in WP-12); one push = one version with `--provenance=false --sbom=false` (WP-12) |
| Artifact Registry `clinic` network egress (added for cost verifier issue 5) | 0 bytes of internet egress: CircleCI pushes (ingress), Cloud Run pulls in us-east4 from the us-east4 repository, CI never pulls | none: internet egress is billed from byte 0 | n/a | rule 11 bans pulls outside Cloud Run; `cost-static` `pkg.dev` check | artifact-registry/pricing | internet-egress billing VERIFIED (cost verifier, 2026-10-16); same-region pull at $0 DEDUCED, WP-00 (i), which is now a precondition of WP-12's first deploy (fallback: C17 after 48 h before any further release; §12.4) |
| Artifact Analysis scanning | 0 (API disabled) | none: $0.26 per image | n/a | API never enabled; C10 | catalog | VERIFIED |
| Secret Manager active versions | 2 lean core (`clinic-database-url-app`, `-migrate`); 4 with S1 + S3 (`-realtime`, `clinic-stream-ticket-key`) | 6 per billing account | 67% lean, 33% with stretch | none; destroy-on-rotate rule + C7 | secret-manager/pricing | VERIFIED |
| Secret Manager access operations | about 500 (instance starts, migrate runs) | 10,000 | 95% | secrets resolved at instance start, never per request | secret-manager/pricing | limit VERIFIED; usage DEDUCED |
| Cloud Storage state bucket (us-east1) | < 1 MB, about 100 Class A and 500 Class B ops (10 applies); egress: state reads to the engineer's laptop in Kenya, < 10 MB | 5 GB-months, 5,000 A, 50,000 B, us-east1 only; 100 GB a month of egress from North America to all destinations except China and Australia | > 98%; egress > 99% | lifecycle keeps 5 noncurrent versions; soft delete 0, **required**: soft-deleted bytes bill as storage | storage/pricing | limits, egress allowance and soft-delete billing VERIFIED (cost verifier, 2026-10-16); flag spelling WP-00 (e) |
| Cloud Logging | about 40 MB (~~22,700~~ 24,400 requests × about 1.5 KB of request + app log) | 50 GiB per project | > 99% | default buckets and retention only; no sinks; no Data Access audit logs; logs per request, not per heartbeat; one free `_Default` exclusion, `drop-iam-denied`, drops Cloud Run request logs of IAM-denied 401s and 403s (C18; widened from 403 only by §12.4), because denied requests are free on Cloud Run but still write logs (deduced), and ingestion past 50 GiB bills $0.50/GiB | free-cloud-features; stackdriver/pricing | limit and overage price VERIFIED; usage DEDUCED |
| Cloud Monitoring | built-in metrics; 1 alert policy; 0 uptime checks | non-chargeable metrics free; alerting free until at least 2027-09-01, then $0.35 per metric reference a month (verified): delete or re-audit before 2027-08-01 (§13.6); 1M uptime executions | n/a | no custom metrics; no uptime pinger (it would also keep Neon awake) | stackdriver/pricing | VERIFIED |
| IAM, WIF (CircleCI and Vercel pools), STS, IAM Credentials | about 300 token exchanges (CI) + about 1,000 (web proxy token refreshes) | free | n/a | none needed | iam/pricing; no catalog SKU | IAM VERIFIED; STS and iamcredentials DEDUCED (no SKU listed) |
| Cloud Build | 0 (never used) | 2,500 build-minutes | n/a | API never enabled; no `--source` deploys | free-cloud-features | VERIFIED |
| Billing budgets (alerts $1, spend cap $3) | 2 budgets | no SKU | n/a | they are the caps | billing budgets docs | VERIFIED (behaviour); cost of budgets DEDUCED $0 |
| Neon Free (aws-us-east-1, 0.25 CU fixed) | ~~about 35~~ about 45 CU-hours (§12.4: stream budget bound); < 50 MB storage; about 0.17 GB egress; 1 branch | 100 CU-hours, 1 GB, 5 GB egress, 10 branches per project | ~~65%~~ 55% CU-h; 95% storage; 97% egress | plan limits suspend compute or block writes; no card, so it cannot bill | neon.com/pricing; /docs/introduction/plans | limits VERIFIED; usage DEDUCED |
| Vercel Hobby (one project, `web`, iad1; ~~`web` + `clinic-frontdoor`~~ superseded, §12.3) | about 30,000 invocations; about 80,000 CDN requests (every proxy call, page and static asset counts; §13.4); 0.17 h Active CPU; ~~about 117 GB-h provisioned memory (112 of it S1 streams at 2 GB, default memory UNVERIFIED, WP-00 (f))~~ about 197 GB-h provisioned memory (192 of it S1 streams: at most 2 streams open at once, 96 h a month by the stream budget, 2 GB each; Hobby memory is 2 GB default and maximum and duration 300 s including streamed responses, VERIFIED, vercel.com/docs/functions/limitations, last updated 2026-08-24, read 2026-10-16; Fluid compute can share one instance across concurrent invocations, so provisioned GB-h is not a per-stream bound; the bound used here is the stream count, §12.4); about 1.1 GB Fast Data Transfer; about 0.3 GB Fast Origin Transfer; 0 image transformations | 1M invocations; 1M CDN requests; 4 h; 360 GB-h; 100 GB; 10 GB; 5,000 | 97%; 92%; 96%; ~~67%~~ 45%; 99%; 97%; 100% | Hobby pauses at limits; no card; single region `iad1`; `images.unoptimized` | vercel.com/docs/plans/hobby (CDN Requests "First 1,000,000", read 2026-10-16) | limits VERIFIED; usage DEDUCED |
| CircleCI Free | about 22,200 credits (conservative ceiling; §13.3 computes 21,500); < 0.5 GB storage; < 0.5 GB network | 30,000 credits; 2 GB; 1 GB | 26%; > 75%; > 50% | credits exhaust → builds blocked, never billed; no card | circleci.com/pricing; docs credits | limits VERIFIED; burn DEDUCED (measured after WP-10) |
| Cloudflare Turnstile (S4) | about 200 siteverify calls | unlimited, 20 widgets | n/a | free plan, no card | developers.cloudflare.com/turnstile/plans | VERIFIED |
| Google OAuth client (S3) | 1 client, openid/email/profile | no cost stated; Testing allows 100 test users | n/a | non-sensitive scopes only | support.google.com/cloud/answer/15549945 | DEDUCED $0 |
| GitHub public repo | branch protection, required checks | free for public repos | n/a | no paid features enabled | docs.github.com protected branches | DEDUCED from the page |
| Docker Hub / mirror.gcr.io pulls | about 6 pulls per pipeline | 200 per 6 h authenticated (free account) | n/a | free account, no Pro | docs.docker.com/docker-hub/usage | VERIFIED; mirror.gcr.io pricing DEDUCED $0 (no billing relationship) |
| GHCR public images (ZAP, Trivy DB fallback) | 1 ZAP pull per pipeline | free for public packages | n/a | none needed | GitHub Packages billing | VERIFIED |
| Trivy, Semgrep CE, gitleaks, pip-audit, pnpm audit, Schemathesis, ZAP, govulncheck, gosec | CLI runs inside CircleCI | OSS, no account | n/a | `--metrics=off`; no SaaS sign-up | docs.semgrep.dev/metrics; trivy.dev | Semgrep metrics VERIFIED; licences DEDUCED |
| Upstash Redis | not provisioned | n/a | n/a | out of scope; re-audit before any provisioning | ADR-0021 | VERIFIED (plan) |

## 13.3 CircleCI credit budget (DEDUCED until WP-10 measures it)

Rates (VERIFIED, price list): Docker small 5, medium 10 credits a minute; Linux VM medium 10; DLC 200 per job (not used).

| Pipeline | Jobs and minutes (spin-up included) | Credits |
|---|---|---|
| PR, lean core, every lane running | quality 2 (small), test 4, contract 3, secrets 1 (small), sast 2 (small), sca 2 (small), web-quality 4 (lean core since §12.3: proxy tests and `next build`), drift 2 (small), cost-static 0.5 (small), image-build-scan about 100, dast about 60 (~~frontdoor-quality 2 (small)~~ superseded: merged into `web-quality`) | about 370 |
| PR with S1 lanes | + realtime-quality, realtime-test, realtime-sec | about 470 |
| Release, lean core | verify jobs + build-scan-push about 100, ship-api about 50, ship-web about 40 (lean core), smoke-public about 5 (small; §12.4, within rounding), cost-check about 5 (~~ship-frontdoor about 40~~ superseded: merged into `ship-web`) | about 640 |
| Release with S1 | + build-scan-push-realtime, ship-realtime | about 740 |
| A self-skipped lane | about 0.5 min on small | about 3 per job |

Month (40 pipelines: 30 PR, 10 main, every lane running): 30 × 470 + 10 × 740 = **21,500 credits of 30,000 (28% headroom)**, before any open-source allowance (recomputed for §12.3; ~~30 × 480 + 10 × 780 = 22,200~~; the 22,200 figure quoted in ADR-0014, ADR-0016, WP-10 and K19 stays as a conservative ceiling). Docs-only and backend-only PRs cost less because the add-on lanes self-skip. If WP-10 measures more than 500 credits for one PR pipeline, the budget is recomputed and the cut order is: make `dast` release-only, then `image-build-scan` release-only.

## 13.4 Worst-case month (DEDUCED; every number is an estimate)

| # | Scenario | Assumption | Drives |
|---|---|---|---|
| W1 | ~~A reviewer keeps the admin dashboard live 8 h a day for 7 days~~ (superseded by §12.4) The stream budget is spent in full | ~~56 connected hours ... the adversarial upper bound~~ The idle close is client-side, so 56 connected hours was not an upper bound: a script can hold 2 streams for 720 h (1,296,000 vCPU-s). The bound is now server-side: at most 345,600 connected seconds (96 h) a month, however many clients, enforced at ticket issue. An honest dashboard spends 700 budget-seconds per 290 s stream, so it gets about 40 connected hours before falling back to click-to-refresh | `clinic-realtime` CPU, front-door memory, Neon hours, poll egress |
| W2 | A patient tab visible and in use 8 h a day for 7 days | polling every 15 s: 56 × 240 = 13,440 availability requests | API requests, Neon hours |
| W3 | 200 bookings through the UI | about 10 API calls per booking flow: 2,000 | API requests |
| W4 | Reviewers run `verify_claims.py` 20 times; Swagger exploration | 20 × 25 = 500; plus 5,000 "Try it out" calls; plus 500 Swagger or ReDoc page loads, each fetching `/docs` (about 1 KB) and `/openapi.json` (estimated 60 KB, ~~4 KB~~; measured in WP-12), which since §12.4 are static and reach only Vercel | API requests, Vercel transfer |
| W5 | 40 CI pipelines (30 PR, 10 main) | 10 release smokes × 30 direct calls = 300; 10 `smoke-public` runs × 25 = 250 through the proxy (§12.4); 10 migrate runs | credits, jobs, egress to CircleCI and Vercel |

**Arithmetic.**
- **API requests:** ~~13,440 + 2,000 + 500 + 5,000 + 300 + 700 (metrics fetch per stream connect) ≈ 22,000; plus about 700 stream connects = 22,700~~ (recomputed by §12.4) 13,440 + 2,000 + 500 + 5,000 + 300 + 250 (`smoke-public`) + 1,200 metrics fetches + 494 tickets (345,600 ÷ 700) ≈ 23,200; plus about 1,200 stream connects (345,600 s ÷ 290 s) = **24,400 Cloud Run requests** (98.8% headroom). Doc-route fetches no longer reach Cloud Run.
- **`clinic-api` compute:** 22,000 × 0.2 s = 4,400 vCPU-s, plus about 300 cold starts × 10 vCPU-s (5 s at 2 vCPU with `--cpu-boost`) = 3,000, rounded up to **8,000 vCPU-s**; memory about **4,000 GiB-s** at 0.5 GiB.
- **`clinic-realtime` compute:** ~~56 h × 3,600 s × 0.25 vCPU = 50,400 vCPU-s~~ the stream budget, 345,600 s × 0.25 vCPU = **86,400 vCPU-s**; 0.25 GiB × 345,600 s = **86,400 GiB-s** (§12.4). Without the budget the adversarial figure is 2 × 720 h × 3,600 × 0.25 = 1,296,000 vCPU-s.
- **Totals against limits:** ~~58,400 of 180,000 vCPU-s (32%); 54,400 of 360,000 GiB-s (15%)~~ 94,400 of 180,000 vCPU-s (52%); 90,400 of 360,000 GiB-s (25%). **Gross** at Tier 1 prices: ~~58,400 × $0.000024 + 54,400 × $0.0000025 ≈ $1.55~~ 94,400 × $0.000024 + 90,400 × $0.0000025 ≈ $2.27 + $0.23 = **$2.49 gross, $0 net** (the free tier is a $4.32 + $0.90 = $5.22 discount). The $3 spend cap does not trip ($0.51 of margin), and the cap sits $2.22 below the discount, which is the margin for its documented enforcement lag ("isn't instantaneous", overages "billed as normal"; budgets-spend-caps, read 2026-10-16). The budget was sized for that: $3 gross minus the API's $0.20 leaves $2.80; 96 h × 3,600 × $0.000006625 a connected second = $2.29, leaving about $0.50 below the cap (deduced).
- **Cloud Run egress (North America):** ~~API responses 22,000 × 4 KB = 88 MB; spec and docs fetches at most 500 × 61 KB = 30 MB ...; gateway polls 201,600 × 0.5 KB = 101 MB; ... ≈ 550 MB, about 49% headroom~~ (recomputed by §12.4; the `s-maxage` cache it relied on can be bypassed with a random query string, because the CDN cache key includes it, deduced) API responses 23,200 × 4 KB = 93 MB; spec and docs fetches **0** (static on Vercel); API → Neon query bytes 23,200 × 5 × 0.5 KB = 58 MB; gateway polls at the budget bound 345,600 × 0.5 KB = 173 MB; stream frames about 3 MB; (93 + 0 + 58 + 173 + 3 = 327 MB) × 2 for TCP, TLS and headers ≈ **655 MB of 1,073.7 MB (1 GiB)**, about 39% headroom. Responses from Neon are ingress (free).
- **Neon:** awake hours W1 ~~56~~ 96 (§12.4) + W2 56 (assumed not to overlap) + other traffic 12 + release smokes 2 + about 150 wake-ups × 5-minute suspend tail 12.5 ≈ ~~138 h ≈ 35~~ 179 h × 0.25 CU ≈ **45 CU-hours of 100**. Held for a whole month at 8 h a day for both W1 and W2 it would be about 124 CU-hours, and Neon would suspend (no charge; an availability risk, K44).
- **Vercel:** about 22,400 front-door invocations + 3,000 web page loads + 400 S3/S4 route calls ≈ **30,000 of 1M**; CDN requests 22,400 proxy calls + 1,000 doc-route requests + 3,000 page loads × about 15 requests each (HTML, JS, CSS, fonts, icons; deduced) + 500 landing loads ≈ 69,000, taken as **80,000 of 1M**; Active CPU 30,000 × 20 ms = 600 s = **0.17 h of 4 h**; provisioned memory ~~W1 56 h × 2 GB = 112 GB-h + 30,000 × 0.3 s × 2 GB ≈ 5 GB-h = 117 of 360 GB-h~~ W1 96 h × 2 GB = 192 GB-h (at most 2 streams at once, so at most 2 instances held by streams) + 30,000 × 0.3 s × 2 GB ≈ 5 GB-h = **197 of 360 GB-h** (§12.4).
- **Artifact Registry:** 2 × about 150 MB + 2 × about 15 MB ≤ **330 MB of 536.9 MB**.
- **Secret Manager:** **4 of 6** active versions with S1 + S3, about 500 of 10,000 accesses.
- **CircleCI:** **22,200 of 30,000** credits (conservative ceiling; §13.3 computes 21,500).

**Verdict for the worst case:** every line is inside its free tier; ~~the tightest are North America egress (about 51% used), Artifact Registry (at least 38%) and CircleCI (26%)~~ (recomputed by §12.4) the tightest are North America egress (about 61% used, 39% headroom), Vercel provisioned memory (55% used), Cloud Run CPU (52% used, with the stream budget spent), Artifact Registry (at least 38% headroom) and CircleCI (26% headroom at the conservative ceiling), and each has a check or a server-side bound that holds before the limit (daily egress alert, the stream budget, the 400 MB assert, the WP-10 credit measurement).

## 13.5 What enforces $0

| Surface | Hard cap (platform) | Configuration guard | Detection |
|---|---|---|---|
| Cloud Run compute and requests | max-instances 3 / 2 (can be exceeded briefly in spikes, per the docs); timeouts; job retries 0; **spend-cap budget $3 gross** (pauses new usage; not instant); IAM gating | min-instances 0 (revision and service level); automatic scaling only (no `--scaling`, no `services replace`, no worker pools; §12.4); CPU throttled; no VPC, no GPU; 0.25 vCPU for streams; monthly stream budget at ticket issue (§12.4) | `cost-check` C1 (incl. cpu-throttling, service-level minScale and scalingMode), C2 (incl. invoker-iam-disabled), C3, C4; `cost-static` flag bans; $1 alert budget |
| Cloud Run egress | none that zeroes it; the spend cap only bounds it | no `allUsers`, `--allow-unauthenticated` or `--no-invoker-iam-check`; North America-only destinations (CircleCI gated by C19); doc routes static, never Cloud Run (§12.4) | daily alert at 30 MB (C12); kill switch on both services (ADR-0023) |
| Artifact Registry | none | cleanup policies; prune after promotion; 2 tags kept; one push = one version (no attestations); no pulls outside Cloud Run | C5, C6; `cost-static` |
| Cloud Logging | none (50 GiB free, then $0.50/GiB) | default buckets; no sinks; one free 401/403 exclusion, `drop-iam-denied` (§12.4) | C3, C18 |
| Cloud Monitoring alerting | none (charges no sooner than 2027-09-01) | delete or re-audit the alert policy before 2027-08-01 | §13.6 dated obligations; ADR-0014 review trigger |
| Secret Manager | none | 4 secrets max; destroy old versions; automatic replication | C7, C8 |
| Cloud Storage | none | us-east1, Standard, lifecycle, soft delete 0 | C9 |
| Neon, Vercel, CircleCI, Cloudflare, Docker Hub | plan limits pause or block; no card on file | fixed 0.25 CU; `iad1`; small/medium classes; no DLC | C13, C15, C16 |
| Everything on the invoice | none | all of the above | C17 (gross and Free Tier savings, not net) |

**The $1 budget does not cap spend.** It sends email at 50%, 90% and 100% of $1 of net cost. It exists to tell us a guard failed, not to stop anything (VERIFIED, billing budgets doc).

## 13.6 Cut, and the one residual

**Cut because it could not be proven $0:**

| Cut | Why | Replaced by |
|---|---|---|
| europe-west3 (and Neon Frankfurt) | Tier 2 compute (about 29% less free CPU) and Europe/Africa egress billed from byte 0 (VERIFIED, catalog) | us-east4 + aws-us-east-1 (ADR-0014) |
| Public `allUsers` invoker on Cloud Run | Every response to a client in Kenya bills $0.12/GiB from byte 0 | IAM-gated Cloud Run behind the Vercel front door (ADR-0023) |
| Direct browser SSE to Cloud Run (S1 as first designed) | Same egress reason | Stream through the front door; if it does not flush, S1 is cut (WP-S1c) |
| `clinic-realtime` at 1 vCPU, concurrency 100 | A 56-hour worst case alone (201,600 vCPU-s) exceeds the 180,000 allowance | 0.25 vCPU, concurrency 1, max 2 |
| Artifact Registry keep-last-5 | 5 API images can exceed 0.5 GiB | 2 versions per package + 400 MB assert |
| Terraform state bucket in europe-west3 | Outside the Cloud Storage Always Free regions, billed from byte 0 | us-east1 bucket (or, with the WP-11 fallback, no bucket) |
| Artifact Analysis scanning | $0.26 per image, no free tier | trivy in CI |
| Cloud Build, `gcloud run deploy --source` | Creates an extra repository and bucket outside the free regions (DEDUCED from known behaviour) | CircleCI builds and pushes by digest |
| CircleCI Docker layer caching, large/Gen2 classes | 200 credits per job; higher rates | `restore_cache`; small/medium |
| Vercel image optimization | 5,000 transformations, then paused features | `images.unoptimized`; static icons |
| Uptime pingers against prod | They keep Neon awake (186 CU-hours a month at 0.25 CU) | measured cold starts instead |
| Per-route Vercel regions (`fra1`) | Hobby allows one function region; a mismatch can fail the deploy | project-wide `iad1` |
| Public Cloud Run through `--allow-unauthenticated` or `--no-invoker-iam-check` | Either makes a service public without an `allUsers` binding, so the original C2 would pass while Kenya egress bills from byte 0 | static ban, C2 annotation check, C3 live (cost verifier issue 2) |
| CPU always allocated, VPC egress, GPUs, service-level min instances | They bill while idle or add billed network resources | static ban; C1 (issue 3) |
| BuildKit provenance/SBOM attestations | Extra Artifact Registry versions per push (deduced) break keep-2 and C6 | `--provenance=false --sbom=false` (issue 6) |
| Uncached `/openapi.json` | Tens of KB per Swagger load is the largest response a reviewer can trigger, and the cheapest egress flood | ~~`s-maxage=600` on Vercel's CDN (issue 11)~~ static doc routes built from the committed contract (§12.4) |
| Doc routes proxied to Cloud Run behind `s-maxage=600` (§12.4) | The CDN cache key includes the query string (deduced), so `/openapi.json?x=<random>` missed every time: about 9,000 requests to 1 GiB | static routes on Vercel; Cloud Run never serves them |
| A public, unmetered SSE stream (§12.4) | The idle close is client-side; a script could hold 2 streams all month (1,296,000 vCPU-s), bounded only by the lagging spend cap | tickets required from S1, monthly connected-seconds budget at ticket issue |
| Cloud Run manual scaling, `services replace`, worker pools (§12.4) | Manual instances bill while idle; a YAML replace bypasses every flag ban; worker pools are always billed | static ban; C1 asserts `scalingMode` = `automatic` |
| A 403-only log exclusion (§12.4) | A junk bearer turns the denial into a 401, which the filter missed | `drop-iam-denied` matches 401 and 403 |
| Pulling images from Artifact Registry outside Cloud Run | Artifact Registry internet egress is billed from byte 0 | CI scans the local build before pushing (issue 5) |

**Residual, stated rather than hidden (K40).** A deliberate flood through the front door of more than about 165,000 requests of the ordinary mix in one month (deduced from about 6.5 KB of Cloud Run egress per request), or **about 12,000 requests of the largest response a client can trigger uncached** (recomputed by §12.4: the 100-item upcoming list of a patient the attacker first fills with 100 bookings, about 45 KB × 2 overhead, deduced; WP-12 measures it; before §12.4 the cheapest flood was about 9,000 uncached `/openapi.json` fetches, not the 165,000 stated), would pass the 1 GiB free egress tier before Vercel pauses the project at 1M function invocations or 1M CDN requests. Beyond 1 GiB the rate is $0.105/GiB. The spend cap bounds the total only if it counts Cloud Run network SKUs, which its page does not say (read 2026-10-16; Q17), so we do not count on it here; the daily alert fires at about 30 MB a day, and the kill switch (removing the web proxy's `roles/run.invoker` binding from `clinic-api` **and** `clinic-realtime`; corrected by the cost verifier, since removing it from `clinic-api` alone left `/api/stream` billing) makes every further request an unbilled IAM denial. The commands are in ADR-0023 and in the "Kill switch" section of `docs/runbooks/bootstrap-gcp.md`, which WP-11 writes. No configuration available to a $0 project removes this path entirely; closing it needs an automated kill switch (TD29) or an always-on load balancer with Cloud Armor, which is not free.

**Second residual, logging (K48).** IAM-denied requests cost nothing on Cloud Run but still write request logs (deduced). The free `_Default` exclusion ~~`drop-iam-403`~~ `drop-iam-denied` stops ingesting them, both the 403 a missing token gets and the 401 a junk bearer gets (§12.4); requests through the proxy are logged normally and are bounded by Vercel's 1M limits at about 1.5 GB of logs a month (deduced), far below the 50 GiB free ingestion. Any other log source past 50 GiB would bill $0.50/GiB (verified); C18 keeps the configuration default.

**Third residual, the stream (K49, §12.4).** Before §12.4 the stream's only server-side bound was the $3 gross spend cap, which lags. Now every stream needs a ticket and each ticket debits 700 s from a 345,600 s monthly budget, so realtime compute is at most 86,400 vCPU-s however many clients try (deduced from the ticket TTL, `STREAM_MAX_SECONDS` and max-instances; "max-instances can be exceeded briefly during spikes", per the max-instances doc, which the $0.51 cap margin absorbs). What remains is that an attacker can spend the month's budget and switch the live feed off for everyone until the next month: a denial of a stretch feature, not a cost. The spend cap stays as the backstop, with its documented lag.

**Dated obligations.** (1) Before **2027-08-01**, delete the egress alert policy and its notification channel, or re-run this proof with the alerting line: alerting charges start no sooner than 2027-09-01 at $0.35 per metric reference a month (verified by the cost verifier, cloud.google.com/stackdriver/pricing). (2) Whenever a free tier changes (Google gives 30 days' notice), re-run this proof before the next deploy (ADR-0014 review trigger).

## 13.7 Final per-resource verdict

| Resource | Verdict | Change applied (where) |
|---|---|---|
| Cloud Run `clinic-api` compute | zero | us-east4 Tier 1; max 3, min 0; spend cap; CPU-always-allocated, VPC and GPU flags banned (ADR-0014, WP-11, WP-12, WP-12a) |
| Cloud Run job `clinic-migrate` | zero | `--task-timeout 600s --max-retries 0` (WP-12); 1-minute billing minimum counted (600 vCPU-s) |
| Cloud Run requests | zero | none needed |
| Cloud Run `clinic-realtime` (S1) | zero, with change | 0.25 vCPU, concurrency 1, max 2; arithmetic corrected (ADR-0014, ADR-0021, WP-S1c); tickets required and a monthly stream budget (§12.4, WP-S1c) |
| Cloud Run egress | zero, with change; one residual (K40) | North America regions; IAM gating; public-access flags banned; proxy in `web/` with ~~CDN-cached~~ static doc routes (ADR-0023, WP-11 Part C, §12.3, §12.4); C19 gate before any CI call to a tag URL |
| Artifact Registry | zero, with change | us-east4; 2 versions per package; prune; 400 MB assert; one push = one version; no pulls outside Cloud Run (WP-11, WP-12, WP-12a, WP-13) |
| Artifact Analysis | zero (kept disabled) | C10 |
| Secret Manager versions | zero | 4 of 6; destroy on rotate (WP-11 runbook) |
| Secret Manager access | zero | none needed |
| Terraform state bucket | zero, with change (was billable) | us-east1, lifecycle, soft delete 0 (WP-11) |
| Cloud Logging | zero, with change | defaults plus one free 401/403 exclusion (WP-11, C18; §12.4); residual K48 |
| Cloud Monitoring | zero until at least 2027-09-01 | one free alert policy, no uptime checks; delete or re-audit before 2027-08-01 (§13.6) |
| IAM, WIF, STS, IAM Credentials | zero | none needed |
| Cloud Build | zero (never used) | C10, global rule 11 |
| Budgets and spend cap | zero, with change | $1 alerts-only + $3 gross spend cap (WP-11 step 4) |
| Billing account | ~~zero, pending Q14~~ **not zero, shared account** (§13.8): compute fits (about $4.38 of the $5.22 discount) but Artifact Registry and Secret Manager are already over their shared free tiers, so this project adds about $0.28 a month | Q14 amended; gross-cost proof (C17); the engineer decides between accepting about $0.28 and moving one side off the account (§13.8) |
| Neon Free | zero, with change | aws-us-east-1; fixed 0.25 CU; no pinger (WP-11) |
| Vercel Hobby | zero, with change | one project `web` (§12.3), bootstrapped by WP-11 Part C0 (§12.4); `iad1` project-wide; `images.unoptimized`; static doc routes; no card; non-commercial note (ADR-0010, ADR-0023, WP-11 Part C, Q16) |
| CircleCI Free | zero, with change | resource classes; no DLC; self-skipping lanes; retention (ADR-0016, WP-10) |
| Cloudflare Turnstile | zero | none needed |
| Google OAuth client | zero | openid/email/profile only |
| GitHub public repo | zero | none needed |
| Docker Hub pulls | zero, with change | `mirror.gcr.io` by digest and for `cimg/*`; ~~`dockerhub-ro` auth~~ no Docker Hub login (WP-10, WP-13) |
| GHCR images | zero | ZAP pinned by digest |
| Trivy | zero | none needed |
| Semgrep CE | zero | `--metrics=off`; no login (WP-13) |
| Other OSS CLIs | zero | none needed |
| Upstash Redis | zero (not provisioned) | re-audit before any provisioning |

## 13.8 Shared billing account: recount from measured usage (2026-10-16)

Q1 was amended: the project sits on the **shared** account `01C382-12CD13-DCA6EF`, not a dedicated one, so §13.2 to §13.7 (which assumed this project was the only user of each per-account free tier) no longer hold as written. Those sections are kept; this one restates the headroom with **observed** numbers. Method: Cloud Monitoring, last 30 days to 2026-10-16, Cloud Run `container/cpu/allocation_time`, `container/memory/allocation_time`, `request_count` and `container/network/sent_bytes_count`, all read-only (`make shared-headroom`, `scripts/shared_headroom.py`; `--account developer` for nanolend-api, master-crossing-435409-r1 and unicorns-484301, `--account the.ace.guru` for pawacloud-assessment). Nothing in the other projects was changed.

| Observed, last 30 days | vCPU-s | GiB-s | Requests | NA egress (MB) | Africa egress (MB) |
|---|---|---|---|---|---|
| nanolend-api (9 services, 6 instance-based, max 10 each) | 19,252 | 7,649 | 11,599 | 83.52 | 2.28 |
| master-crossing-435409-r1 (3 services) | 53,305 | 20,722 | 3,695 | 28.20 | 0 |
| pawacloud-assessment (2 services) | 3,089 | 486 | 316 | 0 | 7.47 |
| unicorns-484301 (no Cloud Run use) | 0 | 0 | 0 | 0 | 0 |
| **Others, observed** | **75,646** | **28,857** | **15,610** | **111.72** | **9.74** |
| This project, worst month (§13.4, DEDUCED) | 94,400 | 90,400 | 24,400 | 655 | 0 |
| **Combined** | **170,046** | **119,257** | **40,010** | **766.72** | |
| Free tier (per billing account) | 180,000 | 360,000 | 2,000,000 | 1,073.74 | |
| **Headroom** | **9,954 (5.5%)** | 240,743 | 1,959,990 | 307.02 | |

Gross compute, combined, priced conservatively at the request-based rates on allocation time: $4.38 against the $5.22 free-tier discount (the catalog, read 2026-10-16, shows identical CPU and memory unit prices in us-east4, us-central1 and africa-south1, so the regional price tier does not change this; §13's "Tier 2" wording for africa-south1 is **not supported by the catalog read**, reported rather than edited).

**Artifact Registry and Secret Manager, observed with read-only `gcloud` (2026-10-16).** Free tiers are per billing account: 0.5 GiB of storage and 6 active secret versions (catalog: `Artifact Registry Storage` $0 to 0.5 GiB then $0.10 per GiB-month; `Secret version replica storage` $0 to 6 then $0.06 per version-month).

| Project | Artifact Registry (MB) | Active secret versions |
|---|---|---|
| nanolend-api | 1,353 | 25 |
| master-crossing-435409-r1 | 24,764 | 16 |
| pawacloud-assessment | 2,372 | 9 |
| unicorns-484301 | API not enabled | not read |
| **Others** | **about 28,488 (27.8 GiB)** | **50** |

**Verdict: $0 does not hold on this account, and the reason is not compute.**

1. **Cloud Run compute, requests and egress: still $0, on observed use, with thin margin.** 170,046 of 180,000 vCPU-s (headroom 9,954, 5.5%) and $4.38 of $5.22. Africa egress of about 9.7 MB is billed from byte 0 at $0.12 per GiB, about $0.001 a month, charged to the other projects and not covered by any free tier. This is a 30-day observation, not a guarantee: nanolend-api's six instance-based services (CPU always allocated, max 10) can each spend more than the whole 180,000 vCPU-s on their own (one instance busy for a month is 2,592,000 vCPU-s), and our spend cap cannot see their use.
2. **Artifact Registry: not $0.** The others hold about 27.8 GiB against a 0.5 GiB shared allowance, so the free storage is already spent and every further byte we push bills at $0.10 per GiB-month: at most 0.4 GiB (the C5 bound) is about $0.04 a month.
3. **Secret Manager: not $0.** The others hold 50 active versions against 6, so all 4 of ours bill at $0.06: about $0.24 a month.
4. **This project adds about $0.28 a month (DEDUCED from list prices and the 400 MB and 4-version bounds); the account already bills the other projects about $5 a month for the same two lines (50 - 6 versions at $0.06, and 27.3 GiB at $0.10, deduced).** The $1 alerts budget was therefore re-scoped from the account to this project (`infra/billing/budget.tf`); an account-wide $1 alert would be permanently in alarm.

What would restore $0, any one of: (a) the engineer accepts about $0.28 a month on the shared account and the README says so; (b) move this project to a billing account of its own (none can be opened, Q1); (c) move the other four projects, or the heavy ones (master-crossing-435409-r1's 24 GiB of images, nanolend-api's 25 secret versions), off this account or clean them up, which is outside this repository and was not touched; (d) cap the other projects' `--max-instances` and switch nanolend-api's six services to request-based billing, which removes the compute risk in item 1 but not items 2 and 3. Only (b) or (c) gives a provable $0; (a) is the honest default.

`make cost-check` now asserts the account's project list (C14) and that the default Compute service account has no `roles/editor` (C20, below); the Artifact Registry and Secret Manager lines in C5 to C8 still measure only this project and so cannot show the shared state, which `make shared-headroom` and this table do.

**Security: the default Compute service account.** `291652953712-compute@developer.gserviceaccount.com` holds `roles/editor` (a GCP default for new projects, reported by the main session). Terraform now removes that grant (`infra/terraform/default_sa.tf`, `google_project_default_service_accounts` with `action = "DEPRIVILEGE"`; the account is left in place); every Cloud Run service and job here is deployed with an explicit `--service-account` (static rule "run deploy missing --service-account", 6 mutation cases); live check C20 asserts no `roles/editor` binding for that member. Not applied: the engineer runs the Terraform step. **UNVERIFIED live:** that the provider's DEPRIVILEGE removes the binding on this project (validated with `terraform validate` only).
