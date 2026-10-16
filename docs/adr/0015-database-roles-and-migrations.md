# ADR-0015: Database roles and migration safety

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, third role `clinic_realtime` for stretch S1

## Status

Accepted

## Context

- **Ordering.** Migrations run against the shared production database before the new revision is smoke-tested. A destructive migration would break the live revision even when the smoke test fails.
- **Privileges.** A runtime that holds DDL rights turns any SQL injection or bug into a schema change.

## Considered options

1. One role for everything.
2. Two roles: `clinic_owner` for migrations and `clinic_app` for runtime, each with its own secret and service account.
3. Option 2 plus an automated N-1 compatibility test.
4. (Stretch S1) Option 2 plus a read-only `clinic_realtime` role for the Go gateway, with its own secret and service account.

## Decision

Option 2, plus enforcement of expand-only migrations. Option 4 if stretch S1 ships.

- **Roles:**
  - `clinic_app` is created in SQL by the owner: `NOSUPERUSER NOCREATEDB NOCREATEROLE`. On Neon this avoids `neon_superuser` inheritance (**unverified**; acceptance checks it).
  - Migration 0001 asserts that the role exists, then grants `SELECT, INSERT, UPDATE` on tables and `USAGE, SELECT` on sequences. It adds matching default privileges. No DELETE is granted.
  - **Stretch S1:** `clinic_realtime` is created in SQL by the owner with the same attributes. Unlike `0001`, migration `0003_event_cursor` does not fail when the role is missing: it adds the column and index, then grants (only if the role exists, otherwise a `NOTICE`) `USAGE` on the schema and column-level `SELECT (id, txid, doctor_id, event_type, from_starts_at, to_starts_at, local_date, from_local_date, occurred_at)` on `appointment_events`: no `appointment_id`, no other table, no default privileges, no writes. This is deliberate: `ship-api` runs `alembic upgrade head` on every merge, and a stretch role must never block a lean-core release. The engineer still creates the role on Neon before merges, and the runbook's creation step re-applies the same grants idempotently, so a skipped grant is recoverable without a new migration. The runbook also sets `idle_in_transaction_session_timeout` on every login role (`clinic_app` and `clinic_realtime` 30 s, `clinic_owner` 5 min), so an abandoned transaction cannot hold the stream horizon back.
- **Secrets:**
  - `clinic-database-url-app` is mounted only on the API service.
  - `clinic-database-url-migrate` is mounted only on the `clinic-migrate` job.
  - Each has its own `secretAccessor` binding.
  - **Stretch S1:** `clinic-database-url-realtime` is mounted only on `clinic-realtime`, readable only by `clinic-realtime-runtime`.
- **Same model everywhere:** compose and CI create `clinic_app` from `backend/docker/initdb/01-roles.sql`, so tests run against the same privilege model as production. Stretch S1 adds `02-realtime-role.sql` for `clinic_realtime`, run by `backend-test` right after `01-roles.sql` and mounted into the `dast` compose stack; the PR is not mergeable until CI creates both roles. Parallel migration branches must end with one alembic head (`alembic heads | wc -l` → `1` in `backend-quality`).
- **Migration safety:**
  - Migrations are expand-only.
  - `scripts/migration_lint.sh` fails CI on `DROP TABLE|COLUMN`, `RENAME`, `SET NOT NULL` or `ALTER COLUMN ... TYPE`, unless the line carries `# contract-ok: <reason>`.
  - `migrations/env.py` takes `pg_advisory_lock(727001)`, so concurrent executions serialize.
- **Seed:** `INSERT ... ON CONFLICT (id) DO UPDATE` only. It never deletes.

## Consequences

- Good: the runtime cannot change the schema (tested: `CREATE TABLE` fails as `clinic_app`).
- Good: destructive changes need an explicit, reviewed annotation.
- Bad: two secrets to rotate (three with S1).
- Good (S1): the gateway cannot read the appointment id that acts as a capability handle while stands, cannot read any patient table, and cannot write (tested: each fails with SQLSTATE 42501).
- Bad: no automated N-1 test. No previous release tag exists before v1.0.0.

## Assessment line

Section 3, "which branch deploys and how": migrations-first deploys are safe by construction, not by hope.

## Review trigger

The first contract (destructive) migration. Adopt the expand/migrate/contract release sequence and the N-1 test before merging it.
