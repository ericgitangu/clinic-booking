# ADR-0018: Testing strategy and the race-proof harness

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (audit 2026-10-17): Built, text stale.** The unit, integration, race and naive-control suites run on real Postgres in CI, and Playwright now runs in the `e2e-real` job. Pending: the idempotent replay race case (needs ADR-0013), a separate 95 percent domain coverage gate, and all stretch-feature tests.

## Context

The brief asks for "at least basic test coverage of booking logic". The headline claim, that a slot can never be double-booked, needs evidence that the test really exercises concurrency. A test that would pass even with sequential requests isn't evidence.

## Considered options

1. Mocked repositories plus SQLite.
2. A pyramid on real PostgreSQL 17, with a naive control as the only control.
3. Option 2 plus a lock-waiter overlap proof and a naive check-then-insert control.

## Decision

Option 3. Everything runs on real Postgres 17: no mocked repositories, no SQLite.

**Layers.**

- **Unit** (`tests/unit`, no DB, `FakeClock`):
  - Slot generation: split shifts, non-working days, edges, the 59/60-minute lead boundary, the horizon, misalignment, and Berlin DST spring-forward and fall-back.
  - The `validate_slot` check order.
  - The error catalogue against `docs/api-errors.md`.
  - Log redaction.
- **Integration** (`httpx.AsyncClient(transport=ASGITransport(app))`):
  - The happy path plus every non-T2 error cell per endpoint, each asserting status, `Content-Type: application/problem+json` and `code`.
  - Local day bounds, DB role privileges, and the no-parameters-in-logs check.
  - Isolation: `TRUNCATE ... RESTART IDENTITY CASCADE` plus a reseed per test, run as the owner.
  - The app connects as `clinic_app`. The clock is fixed at `2026-10-19T04:00Z`.
- **Concurrency** (marker `race`, `DB_POOL_SIZE=30`, `asyncio.Barrier`, one request per task):
  - Case 1: 25 POSTs on one slot, 10 iterations → exactly 1×201 and 24×409 `SLOT_TAKEN`, 1 booked row. A test-only hook adds `pg_sleep(0.2)` before commit. A sampler on a separate connection polls `pg_locks WHERE locktype='transactionid' AND NOT granted` every 20 ms and asserts **peak waiters ≥ 5**. That is direct evidence that the transactions overlapped on the uniqueness check.
  - Case 2: patient double-booked across doctors.
  - Case 3: two reschedules into one slot.
  - Case 4: cancel vs reschedule.
  - Case 5 (T2): an idempotent replay storm.
  - Case 7: a swap (deadlock → retry → no 5xx).
  - Case 8: cancel-at-S alongside reschedule-into-S.
- **Naive control** (marker `control`): in database `clinic_control`, with the unique index dropped, a test-only `NaiveBookingService` does SELECT, `pg_sleep(0.1)`, then INSERT behind the same barrier. We assert booked rows > 1. This shows that check-then-insert double-books under this harness and that the index is what prevents it.
- **Contract:** Schemathesis `from_asgi` with not_a_server_error, status_code_conformance and response_schema_conformance.
- **Migrations:** `upgrade head → downgrade base → upgrade head`, plus constraint and index names asserted in `pg_indexes` and `pg_constraint`.
- **Coverage gate:** `pytest --cov=app --cov-fail-under=85`; domain at 95%.
- **Web:** vitest for the error-code mapping and the slot grid. No Playwright: `verify_claims.py` covers end to end at the API.
- **Stretch S1, cursor correctness (Go, real Postgres 17, build tag `integration`):**
  - `TestOutOfOrderCommits`: T1 begins and writes an event, T2 begins, writes and commits first. The gateway query must return nothing while T1 is open, then exactly [T1, T2] after T1 commits, then nothing. 50 iterations.
  - `TestNaiveIdCursorSkips` (control): the same scenario read with `id > last_id` loses T1's row. Like the booking naive control, this proves the scenario really reorders commits, so the passing test means something.
  - Set-up: schema migrated by alembic as the owner, both roles from the initdb scripts, writer via `RT_TEST_OWNER_URL`, reader via `RT_TEST_REALTIME_URL` as `clinic_realtime`, one clinic/doctor/patient/appointment fixture to satisfy the foreign keys (.
  - `TestResumeExact` and `TestJoinNoGapNoDup`: resume from any emitted cursor and a mid-stream join yield every row exactly once.
  - Unit: cursor parsing, limiter, SSE framing with an injected clock, subscriber count back to 0, zero queries with zero subscribers, and every payload validated against the event JSON Schema with a PII deny-list.
- **Stretch S1, same-transaction proof (Python, real Postgres, owner role):** after real booking, cancel and reschedule calls, the latest event of each appointment has the same `xmin` as the appointment's current row version (cancel and reschedule write a new tuple, so only the latest event is compared). A negative test patches the events repository's insert, inside the test, to raise after the real insert; afterwards neither the appointment nor the event exists. The weaker check that the low 32 bits of `txid` equal the event's `xmin` holds only without savepoints, so it is secondary and dropped if the booking path uses `begin_nested`. A column default always fires in the inserting transaction, so `txid` alone proves nothing about the booking path; the `xmin` join and the negative test do.
- **Stretch S1, end to end:** `scripts/verify_stream.py` after deploy (ADR-0016).
- **Stretch S3:** one negative test per token check (`aud`, `iss`, `exp`, `alg`, allowlist, `email_verified`, JWKS outage) against a locally served JWKS, plus ticket tests in Go (the ticket tests move to S1, with the stream budget).
- **Stretch S2, S4:** vitest for the service-worker caching rules (data routes network-only) and the Turnstile route (forward once on success; no forward on failure or timeout; upstream problems passed through).

**Amendment (2026-10-18): Playwright is in CI.** The Web layer bullet above says "No Playwright"; that is no longer true. The `e2e-real` job (in the `pr` and `release` workflows) starts the real API and Postgres from `docker-compose` (migrations and seed included), runs the generated-client test against them (`packages/api/tests/real-api.test.ts`), the two-instance sign-in test (`apps/booking/tests/two-instances.test.ts`), builds `apps/booking` and runs its Playwright scenarios (`pnpm -C apps/booking test:e2e`). There is no stand-in API. The admin app has a Playwright suite too, run locally with `make e2e-admin` (`scripts/e2e_admin.sh`); it is not a CI job yet. `verify_claims.py` still covers the API end to end after deploy. For stretch S4, the Turnstile route was never built; the reCAPTCHA reject paths are covered by unit tests.

## Consequences

- Good: the README's race claim is backed by two assertions that would each fail if the harness didn't race or the index didn't hold.
- Bad: slower tests. The test-only sleep hook and `NaiveBookingService` must never ship; they live only under `tests/`.

## Assessment line

"At least basic test coverage of booking logic".

## Review trigger

UI regressions. That means a Playwright smoke run against the Vercel production URL. (Amended 2026-10-18: Playwright already runs in CI against the real API in compose, see above; a run against the production URL is still not done.)
