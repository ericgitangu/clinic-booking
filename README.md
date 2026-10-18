# Clinic Booking

A clinic appointment API in which the database, not application code, is what makes double booking impossible, with a Next.js booking app and an admin dashboard on top.

[![CircleCI](https://dl.circleci.com/status-badge/img/gh/ericgitangu/clinic-booking/tree/main.svg?style=shield)](https://app.circleci.com/pipelines/github/ericgitangu/clinic-booking)

## Start here

- **What it is.** Doctors have working hours, a slot is 30 minutes, and a patient can book, cancel and reschedule. FastAPI and Postgres own every rule. The web apps are clients of the same API.
- **Click.** <https://clinic.ericgitangu.com/book> for the patient flow (Google sign-in), <https://clinic.ericgitangu.com/docs> for Swagger UI against the real API (no sign-in, as the brief asks).
- **Read first.** [3.4 The concurrency guarantee](#34-the-concurrency-guarantee) and the two ADRs behind it, [ADR-0003](docs/adr/0003-double-booking-partial-unique-index.md) and [ADR-0018](docs/adr/0018-testing-strategy.md). If that logic is wrong, nothing else matters.
- **Run.** [Section 2](#2-verify-the-claims-in-10-minutes) is a copy-paste path against production: 20 simultaneous bookings of one slot, then cancelling twice.
- **Depth.** Every decision has a one-line summary in [section 4](#4-key-decisions--trade-offs) and an [ADR](docs/adr/README.md) that names what it costs. [`docs/architecture/overview.md`](docs/architecture/overview.md) has the diagrams (context, containers, booking, push, release, data handling), [`docs/engineering/decisions.md`](docs/engineering/decisions.md) the long decisions index, and [`docs/engineering/verification.md`](docs/engineering/verification.md) how each pull request was checked, quoted from its review comments. [Section 4.2](#42-what-i-deliberately-did-not-build-and-the-known-limits) lists what I left out and the limits I know about.
- **The admin app** (<https://clinic-admin.ericgitangu.com>) only admits the allowlisted owner and the people the owner grants access to ([runbook](docs/runbooks/admin-access.md)), so a reviewer cannot sign in. I can grant access if you want to see it.
- **AI use** is described by me in [section 11](#11-ai-reflection). The records it draws on (what I decided, what agents did, the stop rules) are in [`docs/engineering/ai-usage-facts.md`](docs/engineering/ai-usage-facts.md).
- **Live versus declared.** What runs in production and what is only designed is stated in [the architecture overview](docs/architecture/overview.md#what-is-running-and-what-is-declared) and in the status column of [`decisions.md`](docs/engineering/decisions.md#beyond-the-brief).

## 1. Live URLs

| What | Where |
|---|---|
| Landing page | <https://clinic.ericgitangu.com> |
| Booking app | <https://clinic.ericgitangu.com/book> |
| API base | <https://clinic.ericgitangu.com/api> |
| Swagger UI | <https://clinic.ericgitangu.com/docs> |
| ReDoc | <https://clinic.ericgitangu.com/redoc> |
| OpenAPI spec | <https://clinic.ericgitangu.com/openapi.json> |
| Admin app (allowlisted) | <https://clinic-admin.ericgitangu.com> |
| Pipelines | <https://app.circleci.com/pipelines/github/ericgitangu/clinic-booking> |

The earlier address, <https://sil-clinic-booking.vercel.app>, answers with a 308 redirect to the host above. The public REST API is still the product, and the booking pages sit on top of it. Cloud Run itself is IAM-only and only the Vercel proxy can call it.

## 2. Verify the claims in 10 minutes

I ran everything below against production on 2026-10-18 (UTC). The commands are copy-paste. You need `curl`, `jq` and `python3`.

```bash
W=https://clinic.ericgitangu.com
for p in / /docs /openapi.json /api/doctors /api/ready; do
  printf '%-14s ' $p; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' $W$p
done
curl -s -o /dev/null -w 'direct Cloud Run: %{http_code}\n' https://clinic-api-2shno7sa7q-uk.a.run.app/ready
```

| Path | Observed |
|---|---|
| `/` | `200 text/html` |
| `/docs` (Swagger UI) | `200 text/html` |
| `/openapi.json` | `200 application/json` |
| `/api/doctors` | `200 application/json`, 5 doctors seeded, the first is "Dr. Achieng Otieno" |
| `/api/ready` | `200 application/json` (the proxy reaches Cloud Run) |
| Cloud Run directly, `/ready` | `403`: it is IAM-only |

**Step 0: your own patient and a free slot.** Use a patient of your own, not mine. The loop looks for the first day in the next week on which the first doctor has a free slot.

```bash
API=$W/api
PATIENT=$(curl -s -XPOST $API/patients -H 'content-type: application/json' -d '{"full_name":"Your Name"}' | jq -r .id)
DOCTOR=$(curl -s $API/doctors | jq -r '.items[0].id')
for n in 3 4 5 6 7 8 9; do
  DAY=$(python3 -c "import datetime as d; print(d.date.today() + d.timedelta(days=$n))")
  SLOT=$(curl -s "$API/doctors/$DOCTOR/availability?date=$DAY" | jq -r '.slots[0].starts_at // empty')
  [ -n "$SLOT" ] && break
done; echo "$DAY $SLOT"
```

**One booking wins 20 simultaneous requests.**

```bash
BODY="{\"doctor_id\":\"$DOCTOR\",\"patient_id\":\"$PATIENT\",\"starts_at\":\"$SLOT\"}"
seq 20 | xargs -P20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -XPOST $API/appointments \
  -H 'content-type: application/json' -d "$BODY" | sort | uniq -c
```

Observed: `1 201` and `19 409`. The partial unique index rejects the other 19 as `SLOT_TAKEN`. The same 20-way run on my local compose stack on 2026-10-16 also gave one 201 and 19 409s, and the slot then disappeared from availability. The committed test `backend/tests/concurrency/test_race_same_slot.py` fires 25 requests and expects one 201 and 24 409s; run it with `make test-race`.

**Cancelling twice.**

```bash
ID=$(curl -s "$API/patients/$PATIENT/appointments" | jq -r '.items[0].id')
curl -s -XPATCH $API/appointments/$ID/cancel -H 'content-type: application/json' -d '{"reason":"gate check"}' -o /dev/null -w '%{http_code}\n'
curl -s -XPATCH $API/appointments/$ID/cancel -H 'content-type: application/json' -d '{"reason":"gate check"}' -w '\n%{http_code} %{content_type}\n'
```

Observed: the first returns `200`. The second returns `409` as `application/problem+json` with code `APPOINTMENT_ALREADY_CANCELLED` and a `request_id`.

**Rerunning locally.** `make e2e` always starts from a fresh database (it runs `docker compose down -v && docker compose up -d --build --wait` first), so rerun it as often as you like. The fresh-database rule matters only if you run Playwright directly (`pnpm -C apps/booking test:e2e`) against a stack you kept, or `KEEP_STACK=1 make e2e-admin`: then run `make down` first (it runs `docker compose down -v`; `make down -v` would only print Make's version).

**The full script.** `make verify URL=$API` runs the end-to-end claims check (`scripts/verify_claims.py`) and needs `uv`. Observed on 2026-10-18 in the documentation lane, the script printed `17/17 passed` against production. The release pipeline runs the same script against each new revision before it gets traffic, and runs `cost_check.sh --live` after the deploy.

## 3. System design

This section is the shape of the system. Section 4 is why I chose it over the alternatives. Each decision links to its ADR in [`docs/adr/`](docs/adr/README.md).

### 3.1 Context and containers

```mermaid
flowchart LR
  P([Patient or reviewer]) -->|HTTPS| W[web: Next.js on Vercel iad1<br/>landing page, static /docs, /api proxy]
  W -->|Google ID token via Vercel OIDC| A[clinic-api: FastAPI on Cloud Run us-east4<br/>IAM-only, min 0 / max 3]
  A -->|asyncpg, role clinic_app| D[(PostgreSQL 17: Neon aws-us-east-1)]
  M[clinic-migrate: Cloud Run Job] -->|alembic, role clinic_owner| D
```

One service owns every business rule and one database holds the state. The browser never talks to Cloud Run directly: the Vercel project is the only public entry point, and Cloud Run has no `allUsers` invoker ([ADR-0014](docs/adr/0014-hosting-region-and-cost.md), [ADR-0023](docs/adr/0023-zero-cost-edge-front-door.md)). The admin app is a second Vercel project that reaches the same API the same way ([ADR-0027](docs/adr/0027-two-apps-in-a-workspace.md)). Booking emails (PR 27, in flight) are sent from `Idyllic Clinic Booking <reminders@mail.ericgitangu.com>` with the reply-to set to my own address. a subdomain keeps the root domain's reputation out of it (per the ADR-0025 amendment in PR 27). `mail.ericgitangu.com` was the only domain showing Verified on my Resend Domains page when it was checked on 2026-10-18 ([`verification.md`](docs/engineering/verification.md)). Code layers inside the API are `api/` (parse and serialize), `services/` (own the transaction), `domain/` (pure, no I/O) and `repositories/` (SQL and constraint mapping) ([ADR-0002](docs/adr/0002-fastapi-single-system-of-record.md)).

### 3.2 Data model

```mermaid
erDiagram
  clinics ||--o{ doctors : employs
  doctors ||--o{ working_hours : "works (weekday, window)"
  doctors ||--o{ appointments : "is booked in"
  patients ||--o{ appointments : holds
  appointments ||--o{ appointment_events : "audit trail"
```

- `clinics.timezone` is an IANA name stored as data, seeded as `Africa/Nairobi`.
- `working_hours` is a clinic-local wall-time window per doctor and ISO weekday. A CHECK keeps both ends on :00 or :30.
- `appointments` carries `starts_at` and `ends_at` as `timestamptz`, `status` in (`booked`, `cancelled`), and CHECKs that pin `ends_at = starts_at + 30 min` and the half-hour grid.
- `appointment_events` is written in the same transaction as every state change. It is the audit trail, and the admin dashboard reads it for the appointment lineage view ([ADR-0009](docs/adr/0009-realtime-polling-now-sse-later.md)).
- Roles: migrations run as `clinic_owner`, the service runs as `clinic_app` with no DDL rights ([ADR-0015](docs/adr/0015-database-roles-and-migrations.md)).

### 3.3 Slots are computed, not stored

The brief gives working hours and a fixed 30-minute slot. I derive free slots on request: cut each working window into 30-minute steps in UTC, subtract the booked starts for that clinic-local day, and drop anything before `now + 60 min`. It is a pure function, `domain/slots.py::generate_slots`, backed by two indexed queries per request ([ADR-0004](docs/adr/0004-computed-slots.md)). The cost is that there is no slot row to lock, so uniqueness cannot live on the slot. It has to live on the appointment, which is the next section.

### 3.4 The concurrency guarantee

The brief says a booked slot must not be available to others. Two concurrent POSTs for the same slot is the case that breaks check-then-insert, and `SELECT ... FOR UPDATE` cannot lock a row that does not exist yet.

```sql
CREATE UNIQUE INDEX uq_appt_doctor_slot_booked
  ON appointments (doctor_id, starts_at) WHERE status = 'booked';
```

The database is the arbiter. The service inserts and maps the unique violation (SQLSTATE 23505, by constraint name) to `409 SLOT_TAKEN`. There is deliberately no "is it taken?" pre-check, because any such check is a window for a race and adds nothing the index does not already enforce. A cancelled row drops out of the partial index, so the slot is free again while the history stays. A second index on `(patient_id, starts_at)` stops one patient holding two slots at the same instant ([ADR-0003](docs/adr/0003-double-booking-partial-unique-index.md)).

The test is built so it cannot pass vacuously ([ADR-0018](docs/adr/0018-testing-strategy.md)). The race test releases 25 POSTs for one slot at an `asyncio.Barrier`, holds the transaction open for 200 ms with a test-only `pg_sleep`, and samples `pg_locks`. It repeats over 10 slots (with `DB_POOL_SIZE=30`, so all 25 requests can be in flight) and asserts that the peak count of transactions blocked on the uniqueness check, across them, is at least 5. Per slot it asserts exactly one 201, twenty-four 409s with code `SLOT_TAKEN`, and one booked row. The control releases the same barrier against a database with the index dropped, using a check-then-insert `NaiveBookingService`, and asserts more than one booked row, which shows the index is what holds. Run them with `make test-race` and `make test-control`.

### 3.5 Appointment state machine

```mermaid
stateDiagram-v2
  [*] --> booked: POST /appointments (201)
  booked --> booked: reschedule (200, same id)
  booked --> cancelled: cancel (200)
  cancelled --> [*]
```

`cancelled` is terminal, and cancelling or rescheduling a cancelled appointment is `409 APPOINTMENT_ALREADY_CANCELLED`. A reschedule is one `UPDATE` of `starts_at` under `SELECT ... FOR UPDATE`, using the same validator as a fresh booking. It frees the old slot and claims the new one atomically, and if the new slot is taken the transaction rolls back and the original booking is untouched. I chose an in-place update over cancel-and-reinsert so the appointment id stays stable for the client ([ADR-0008](docs/adr/0008-appointment-lifecycle-and-reschedule.md)). I left out `completed` and `no_show` because nothing in the brief tracks attendance.

### 3.6 Time model

- Storage is UTC `timestamptz`. The clinic's zone is data (`clinics.timezone`), so a second clinic needs no code change.
- Input must be RFC 3339 with an offset. A naive datetime is `422 TIMEZONE_REQUIRED` rather than a guess. Output is in the clinic offset plus a `timezone` field.
- "A day" means the clinic-local day, converted to a UTC range `[D 00:00, D+1 00:00)` for the booked-starts query.
- The clock is injected through a FastAPI dependency. Business SQL never calls `now()`; the current instant is a bind parameter. Ruff bans `datetime.now`, `utcnow` and friends outside `core/clock.py`, so a test pins time with a fake clock and passes on any weekday.
- Nairobi has no DST, so DST tests run in `Europe/Berlin` ([ADR-0005](docs/adr/0005-time-and-timezone-model.md)).

## 4. Key decisions & trade-offs

### 4.1 The headline decisions

Each row is the decision, what it costs me, and the ADR that weighs the alternatives. The ADRs are where the depth is; [`docs/engineering/decisions.md`](docs/engineering/decisions.md) adds the alternative I rejected on each row.

| Decision | What it costs | ADR |
|---|---|---|
| A partial unique index on `(doctor_id, starts_at) WHERE status = 'booked'` decides double booking, with no application lock | Correct only for fixed, aligned 30-minute slots; variable lengths mean migrating to an `EXCLUDE USING gist` constraint | [0003](docs/adr/0003-double-booking-partial-unique-index.md) |
| Slots are computed from working hours, never stored | No slot row to lock, so uniqueness lives on the appointment | [0004](docs/adr/0004-computed-slots.md) |
| FastAPI is the single system of record; Go is allowed only for an optional read-only gateway | Python cold starts are slower than Go's; I mitigate with `--cpu-boost` and have not measured it | [0002](docs/adr/0002-fastapi-single-system-of-record.md), [0021](docs/adr/0021-go-realtime-gateway.md) |
| UTC `timestamptz`, the clinic zone as data, naive datetimes rejected, an injected clock | One extra join to read the zone; no DST zone is in the seed data | [0005](docs/adr/0005-time-and-timezone-model.md) |
| REST with OpenAPI 3.1, RFC 9457 errors with a closed code catalogue, and a TypeScript client generated from the contract | Type safety comes from codegen and a CI drift gate instead of inference; the generator is 0.x and pinned; no `/v1` prefix | [0006](docs/adr/0006-problem-details-error-model.md), [0007](docs/adr/0007-api-style-rest-openapi.md), [0011](docs/adr/0011-openapi-codegen-contract.md) |
| Reschedule is an in-place update under a row lock with one deadlock retry; a booking retry replays through an idempotency key stored on the appointment | A slot swap can end with both requests rejected; a key is bound to one doctor and time | [0008](docs/adr/0008-appointment-lifecycle-and-reschedule.md), [0013](docs/adr/0013-idempotency-keys.md) |
| Cloud Run is IAM-only behind a Vercel proxy, in `us-east4` beside Neon | An estimated 100 to 150 ms more per warm request for Kenyan users than a Frankfurt layout (not measured), and about $0.34 a month on the shared billing account | [0014](docs/adr/0014-hosting-region-and-cost.md), [0023](docs/adr/0023-zero-cost-edge-front-door.md) |
| CircleCI, keyless OIDC to workload identity federation, promote by tag after a smoke test, roll back automatically | `VERCEL_TOKEN` is long-lived; a main pipeline takes about 10 to 12 minutes (an estimate) | [0016](docs/adr/0016-cicd-circleci-keyless-deploy.md) |
| The public API stays unauthenticated as the brief says; patients and staff sign in with Google in the web apps, with one reCAPTCHA check per action and roles checked on every request | Anyone holding an appointment id can change it through the public API (an IDOR I disclose in section 10) | [0012](docs/adr/0012-identity-and-abuse-controls-deferred.md), [0024](docs/adr/0024-google-sign-in-with-better-auth.md), [0029](docs/adr/0029-booking-flow.md), [0030](docs/adr/0030-staff-roles-and-access.md) |
| Real Postgres in every test, a race harness that fails if it stops being concurrent, and a control that proves the index is what holds | Slower suites and a compose database in CI; no mocks to hide behind | [0018](docs/adr/0018-testing-strategy.md) |

**What breaks at 10x and 100x.** These are deductions from the configuration, not load tests. Connections go first: each instance holds a pool of 5 against Neon's direct endpoint, with at most 3 instances, so 15 connections. More instances multiply that against a 0.25 CU compute; the fix would be Neon's pooler, which needs asyncpg's statement cache turned off (unverified here). Cold starts are second: scale-to-zero is a cost choice, and `min-instances 1` is the knob when latency matters more than the free tier. At 100x one Postgres primary is the ceiling. The unique index contends only per doctor and slot, so it does not serialize unrelated bookings, and a read replica for availability comes before any sharding. Multi-clinic needs `clinic_id` scoping and tenant isolation, not new time logic.

### 4.2 What I deliberately did not build, and the known limits

- **Patient authentication on the public API** ([ADR-0012](docs/adr/0012-identity-and-abuse-controls-deferred.md)). The brief's endpoints are unauthenticated and Swagger's Try it out has to work. The cost is an IDOR: anyone holding an appointment or patient UUID can read or change it there, and a duplicate-phone error tells a caller whether a number is registered. The signed-in screens close this in the web path only.
- **Rate limiting in the API.** There is a per-client limit in the Vercel proxy (120 requests a minute by default, per instance, `packages/api/src/proxy/rate-limit.ts`) and none inside the API, where a trustworthy client IP is not available behind Cloud Run and the proxy.
- **A booking cap per patient.** The brief does not ask for one, and it would lock reviewers out of shared demo patients.
- **Variable slot lengths, multiple timezones per request, `completed` and `no_show` states.** Fixed 30 minutes and two states match the brief.
- **Early session revocation.** Sessions are stateless cookies, so a role is looked up in `staff_access` on every request instead of living in the cookie ([ADR-0030](docs/adr/0030-staff-roles-and-access.md)).
- **Measured latency and load.** The latency and 10x figures above are estimates and are labelled as such.
- **A live admin feed.** I descoped it. The Go gateway I designed for it ([ADR-0021](docs/adr/0021-go-realtime-gateway.md)) billed about 900 vCPU-seconds per connected hour against roughly 21,619 vCPU-seconds of shared free-tier headroom and held 2 concurrent streams, so I closed that pull request (PR 37) and chose Ably's free package, which needs no payment method (evidence: `docs/evidence/ably-no-payment-method-2026-10-18.md`). The relay can publish admin events; no admin screen consumes them. The dashboard refreshes on request.
- **The admin release path is blocked on one secret.** `ship-admin` failed because the CI Vercel token was scoped to `clinic-web`; each project now has its own token, and the admin ship, rollback and public checks pass only after `VERCEL_ADMIN_TOKEN` is added to the `vercel-prod` context. Until then `verify-release`, `smoke-public` and `zap-prod` have not run on a release.
- **End-to-end tests assume a fresh database per run.** CI provides one, and `make e2e` recreates the compose volume itself. Running Playwright directly on a reused database (`pnpm -C apps/booking test:e2e`, or `KEEP_STACK=1 make e2e-admin`) fails the double-booking specs and the fixed-slot `booking.spec` test (also on `main`); run `make down` first. Per-run port and database isolation is descoped for time.
- **Booking emails are in flight.** PR 27 is open.
- **The admin app cannot be tried without an invitation**, for the reason in the Start here list.

### 4.3 Beyond the brief

- **Race-proof tests with a naive control** that must fail without the index: `make test-race`, `make test-control` ([ADR-0018](docs/adr/0018-testing-strategy.md)).
- **Idempotency keys** on booking: a retry after a lost response returns the original booking instead of telling the real booker they lost the slot ([ADR-0013](docs/adr/0013-idempotency-keys.md)).
- **Immutable releases with automatic rollback.** Every release is a tagged Cloud Run revision smoke-tested before it gets traffic, and a failed public check moves traffic back ([ADR-0016](docs/adr/0016-cicd-circleci-keyless-deploy.md), [rollback runbook](docs/runbooks/rollback.md)).
- **Keyless deploy.** No long-lived GCP credential exists; CircleCI exchanges its OIDC token for a short-lived one, and only for `main` ([ADR-0016](docs/adr/0016-cicd-circleci-keyless-deploy.md)).
- **Security gates in CI.** gitleaks, semgrep, pip-audit, a trivy image and config scan and a ZAP API scan, each wired as a CI job that fails on findings (ZAP fails on exit codes 1 and 3; warnings only pass) ([ADR-0017](docs/adr/0017-security-testing.md)).
- **Cost guards.** `cost_check.sh` runs statically on every PR and live after each deploy, and has a self-test that mutates the config to prove it fails ([ADR-0014](docs/adr/0014-hosting-region-and-cost.md), [ADR-0023](docs/adr/0023-zero-cost-edge-front-door.md)).
- **Admin dashboard** with three roles and an appointment lineage view ([ADR-0027](docs/adr/0027-two-apps-in-a-workspace.md), [ADR-0030](docs/adr/0030-staff-roles-and-access.md)).
- **Google sign-in and a reCAPTCHA check per action** on the patient screens ([ADR-0024](docs/adr/0024-google-sign-in-with-better-auth.md), [ADR-0029](docs/adr/0029-booking-flow.md)).
- **A generated, validated client.** Types, zod schemas and the SDK come from the OpenAPI contract, and CI fails on drift ([ADR-0011](docs/adr/0011-openapi-codegen-contract.md)).
- **Request-id logging** with no PII in logs ([ADR-0019](docs/adr/0019-observability.md)), and branding, a web manifest and a sitemap ([ADR-0026](docs/adr/0026-branding-and-seo.md)).
- **A shell-only PWA and slot lists that refresh** every 15 seconds while the tab is visible, with an idle stop ([ADR-0009](docs/adr/0009-realtime-polling-now-sse-later.md), [ADR-0010](docs/adr/0010-thin-nextjs-booking-ui.md)).
- **Live slot events.** The API publishes them through an outbox relay to Ably, with a hard monthly publish budget (25,000) and polling as the fallback ([diagram](docs/architecture/overview.md#4-a-booked-slot-reaching-other-open-pages)). The publish side is live: booking and then cancelling in production moved the Ably message count from 17 to 21. The booking page subscribes in PR 44, which is open, so until it merges the pages rely on the 15 second polling.
- **Booking emails and a daily reminder** through Resend, sent only to verified, linked accounts ([ADR-0025](docs/adr/0025-email-with-resend.md)). PR 27 is open, so this is in flight and not running in production.
- **Swagger UI, ReDoc and fonts served from the repo**, so the first click does not depend on a CDN.
- **A production ZAP baseline, Lighthouse budgets, an image prune and a kill switch** for the deployed services ([ADR-0017](docs/adr/0017-security-testing.md), [rollback runbook](docs/runbooks/rollback.md)). The Lighthouse `/` performance rule is a warning: CI medians varied from 77 to 89 run to run.

The status of each item (shipped, declared, descoped) and what it costs is in [`docs/engineering/decisions.md`](docs/engineering/decisions.md#beyond-the-brief).

## 5. API reference & error catalogue

The live, interactive reference is [Swagger UI](https://clinic.ericgitangu.com/docs); the contract is committed at `contracts/openapi.json`. The public endpoints:

| Method and path | Purpose | Success |
|---|---|---|
| `GET /doctors`, `GET /doctors/{id}` | Doctors with clinic and working hours | 200 |
| `GET /doctors/{id}/availability?date=` | Free 30-minute slots on a clinic-local day | 200 |
| `POST /patients` | Create a patient | 201 |
| `POST /appointments` | Book a slot | 201 |
| `GET /appointments/{id}`, `GET /patients/{id}/appointments` | Read one, or a patient's list | 200 |
| `PATCH /appointments/{id}/cancel`, `/reschedule` | Change state | 200 |
| `GET /health`, `GET /ready`, `GET /problems/{slug}` | Liveness, readiness (`SELECT 1`), error type documents | 200 |

The `/internal/*` endpoints serve the web apps and need a signed assertion; they are in the contract but not callable from Swagger. Every non-2xx is `application/problem+json` with a stable `code` and a `request_id`. The status rule: 404 means the resource in the path does not exist; 422 means the request is well-formed but resending it unchanged can never succeed; 409 means it conflicts with current state and might succeed later. The full code table is in [`docs/api-errors.md`](docs/api-errors.md), which a test checks against the code ([ADR-0006](docs/adr/0006-problem-details-error-model.md)).

## 6. Code structure

| Path | What is in it |
|---|---|
| `backend/app/` | FastAPI service: `api/`, `services/`, `domain/` (pure rules), `repositories/`, `models/`, `schemas/`, `core/` |
| `backend/migrations/`, `backend/tests/` | Alembic (expand-only, linted by `scripts/migration_lint.sh`); unit, integration, concurrency, contract, migration tests |
| `apps/booking/`, `apps/admin/` | The two Next.js apps ([ADR-0027](docs/adr/0027-two-apps-in-a-workspace.md)) |
| `packages/api/`, `packages/ui/` | Generated client and the `/api` proxy; shared UI |
| `contracts/` | The committed OpenAPI contract |
| `infra/`, `.circleci/`, `scripts/` | Terraform and bootstrap, the pipelines, verification and cost scripts |
| `docs/` | ADRs, runbooks, the error catalogue |

`make help` lists every task ([ADR-0001](docs/adr/0001-monorepo-layout-and-task-runner.md)).

## 7. Testing

**Everything runs against the real thing.** Backend tests use real Postgres 17 with no mocked repositories. The web gate is the `e2e-real` CI job: it brings up the real API and Postgres with docker compose (migrations and seed included) and runs the browser scenarios (`apps/booking/e2e`) and the generated client's tests (`packages/api/tests/real-api.test.ts`) against them: booking, a double booking, cancelling, cancelling twice, rescheduling, a past time, a time under an hour away, and the typed error for each. Stand-ins exist only where a real response cannot be produced or the service is a third party: Google's token endpoint in the sign-in tests, and a damaged real response in the generated client's drift test, each labelled in the test. The reCAPTCHA check is switched off for test runs only (`apps/booking/src/lib/human-check.ts`), and its verifier is unit-tested on every reject path.

Four flakes were root-caused rather than retried: the script tests' shared fixed ports and the `CIRCLE_BRANCH` leak ([PR 49](docs/engineering/verification.md), [PR 43](docs/engineering/verification.md)), the live admin-channel test ([PR 45](docs/engineering/verification.md)) and the fonts spec ([PR 47](docs/engineering/verification.md)); the booking double-submit test is fixed in PR 48, which is open. Test counts, coverage and the mutation checks that proved the tests can fail are quoted from each pull request's review in [`docs/engineering/verification.md`](docs/engineering/verification.md). The backend job fails under 85% coverage and a separate unit-only gate holds the pure domain code at 95%. The race harness is described in [3.4](#34-the-concurrency-guarantee).

**Generated client.** The types, zod schemas and SDK in `packages/api/src/generated` come from `contracts/openapi.json` (`make gen-client`, `@hey-api/openapi-ts`), and the lint job fails if they differ from a fresh run ([ADR-0011](docs/adr/0011-openapi-codegen-contract.md), [ADR-0029](docs/adr/0029-booking-flow.md)).

Run each layer locally: `make lint hygiene`; backend tests with `cd backend && uv run pytest` against the compose database; web unit tests with `pnpm -r test` (add `REAL_API_URL=http://127.0.0.1:8080` to include the real-API client tests); browser tests with `make e2e`, which recreates the compose stack and its volume first, so it always runs on a fresh database.

Observed in production on 2026-10-18: 20 parallel `POST /api/appointments` for one slot returned one 201 and 19 409s (`SLOT_TAKEN`), the same as the local race test.

## 8. Ambiguities & decisions

The brief leaves these open. I picked an answer, and each is a one-line change if you disagree.

- **Overlap.** With fixed 30-minute slots, "overlapping" means "same `starts_at`", so a unique index is enough ([ADR-0003](docs/adr/0003-double-booking-partial-unique-index.md)).
- **Lead time and horizon.** A booking needs at least 60 minutes of notice and at most 90 days ahead (`BOOKING_MIN_LEAD_MINUTES`, `BOOKING_HORIZON_DAYS`).
- **Cancelling or rescheduling an appointment that has started** is `409 APPOINTMENT_ALREADY_STARTED` ([ADR-0008](docs/adr/0008-appointment-lifecycle-and-reschedule.md)).
- **Which timezone is "a day".** The clinic's, stored as data ([ADR-0005](docs/adr/0005-time-and-timezone-model.md)).
- **Who may cancel.** Through the public API, anyone with the id (the brief has no auth). In the web apps, only the signed-in patient who owns it, or staff ([ADR-0012](docs/adr/0012-identity-and-abuse-controls-deferred.md), [ADR-0029](docs/adr/0029-booking-flow.md)).

## 9. Deployment & CI/CD

**CI runs on CircleCI, not GitHub Actions.** GitHub Actions was not available on my account because of a billing issue, so the pipeline runs on CircleCI; the repository stays on GitHub ([ADR-0016](docs/adr/0016-cicd-circleci-keyless-deploy.md)).

**Which branch deploys.** Only `main`. Pull requests run the verify jobs: lint, backend quality, tests and contract tests, gitleaks, semgrep, pip-audit, an image build with a trivy scan, ZAP, web quality, `e2e-real` and the static cost check. A push to `main` runs the same jobs and then ships: build and push the image by digest, run migrations (expand-only, as `clinic_owner`), deploy a no-traffic revision, run `scripts/verify_claims.py` against its tagged URL, and promote it only if the commit is still the head of `main`. The booking and admin apps deploy to Vercel after the API. The deploy contexts are restricted to `main` and so is the workload identity federation condition, so a branch pipeline cannot deploy even if someone edits the config file.

**Rollback.** Going back is a traffic move, not a rebuild. After the web deploy, `verify-release` checks the public URL with no credentials (including `/ready`, which runs `SELECT 1` against Neon); if that fails, one job puts the API back on the revision that was live before and a second job, run only if the first succeeded, points the Vercel alias at the previous deployment, then the release stays red. It refuses to roll back to the placeholder image or when something else has already moved traffic. Deploys are also recorded as CircleCI deploy markers, and `.circleci/rollback.yml` is the one-click version for the CircleCI UI. The runbook is [`docs/runbooks/rollback.md`](docs/runbooks/rollback.md).

## 10. Operations, cost & security posture

**Security note.** Signing in with Google and the reCAPTCHA check protect the web screens and the web app's own `/internal` routes: a patient reaches only their own appointments (the API answers 404 for anyone else's), and the patient is always derived from the account, never from the browser. The public REST API at `/api` is intentionally unauthenticated, as the brief requires, so Swagger's Try it out works. It is rate-limited per IP at the proxy, and patient-scoped reads there rely on unguessable UUIDs, so anyone who has an appointment or patient id can read or change it there. That is accepted debt, and it also means the phone-number check on patient creation (a duplicate phone returns `PATIENT_PHONE_EXISTS`) tells an API caller whether a number is registered. Review trigger: any real patient data, or a need to authenticate the public API (ADR-0012, ADR-0022, ADR-0024, ADR-0029).

**Cost disclosure.** The GCP project shares a billing account with other projects, whose use has already exhausted the shared Artifact Registry and Secret Manager free tiers, so this project bills about $0.34 a month there (accepted); Cloud Run compute and egress stay within the free tier. I approved a ceiling of about $0.34 a month. A $3 Cloud Run spend cap is set in the cloud console (status Configured, recorded in [`docs/evidence/spend-cap-2026-10-18.md`](docs/evidence/spend-cap-2026-10-18.md)), and `cost_check.sh --live` checks that the two budgets exist (it needs a billing login, so it runs locally); that the cap action is on can only be confirmed in the console. Ably's free package needs no payment method (evidence: `docs/evidence/ably-no-payment-method-2026-10-18.md`). The $0 rule was my own constraint, not the brief's. The reasoning, the region audit and the recount are in [ADR-0014](docs/adr/0014-hosting-region-and-cost.md) and [ADR-0023](docs/adr/0023-zero-cost-edge-front-door.md); `cost_check.sh` is the guard.

## 11. AI reflection

### What I used AI for
<!-- ENGINEER: factual bullets + a per-WP table of how much code was agent-generated vs hand-written -->

### An example where AI improved my work
<!-- ENGINEER: verbatim prompt from the exported session transcript (prompt id from the AI usage summary in README section 11), what changed, commit SHA -->

### An example where AI was wrong or incomplete, and how I caught it
<!-- ENGINEER: a real entry with its source; how it was caught (test / doc / observation); fix commit -->

### Two decisions I made without AI, and why
<!-- ENGINEER: decision 1 -- must predate or override AI output; cite the message/commit -->
<!-- ENGINEER: decision 2 -- same rule -->

### Note on commits

AI usage is summarized here in section 11; commit messages carry no tooling trailers by convention.

## 12. Run locally

Prerequisites: Docker, uv and pnpm, plus the Vercel CLI for the web app's environment.

The booking app reads its settings from `apps/booking/.env.local`, which is gitignored. `apps/booking/.env.example` lists every variable name with a comment and no values. Run this once, signed in to Vercel, to fill the file from the project's Development environment. Vercel never returns variables marked Sensitive (the Google client, the auth secret and the like), so the command prints which ones to copy into the file by hand:

```bash
make env-pull
```

```bash
make up        # docker compose up -d --build --wait: Postgres, migrations plus seed, the API on :8080
curl -s localhost:8080/ready
make test      # full backend suite against that database
```

The API alone needs only Docker, so you can run [section 2](#2-verify-the-claims-in-10-minutes) against `http://localhost:8080` (set `API=http://localhost:8080`).
