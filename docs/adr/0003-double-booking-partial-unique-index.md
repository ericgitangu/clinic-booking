# ADR-0003: Double-booking prevention with a partial unique index

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (audit 2026-10-17): Built.** Both partial unique indexes, the duration and alignment CHECKs and the SQLSTATE to 409 mapping are in migration 0001 and covered by tests. Unverified: the Neon `btree_gist` check.

## Context

The brief says: "Once booked the slot must not be available to others." Checks in application code race when POSTs arrive concurrently. `SELECT ... FOR UPDATE` cannot lock a row that doesn't exist yet.

## Considered options

1. A partial unique index `(doctor_id, starts_at) WHERE status='booked'` at READ COMMITTED.
2. `EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status='booked')`, which needs btree_gist.
3. SERIALIZABLE with retries, or advisory locks, or check-then-insert.

## Decision

Option 1, with these additions:

- **Patient twin.** A second index on `(patient_id, starts_at)` stops one patient holding two slots at the same time.
- **CHECKs.** They pin `ends_at = starts_at + 30 min` and the 1800-second alignment, so equal `starts_at` is the same thing as overlap.
- **Error mapping.** IntegrityError is mapped to a 409 by SQLSTATE and constraint name. There is no slot-taken pre-check.
- **PostgreSQL 17 everywhere.** SQLite is forbidden, even in tests.

## Consequences

- Good: race-free with no locks in the application. The single source of the 409 is the database.
- Good: cancelled rows drop out of the index, so a cancelled slot is free again while the history is kept.
- Bad: correct only for fixed, aligned 30-minute slots, and the alignment CHECK holds only for whole or half-hour UTC offsets.
- Bad: constraint names become part of the contract. A test asserts they exist in `pg_indexes` and `pg_constraint`.
- Note: Alembic autogenerate is not trusted for partial indexes. They are written as raw SQL.
- Proof that it holds under real concurrency, as opposed to by construction: see ADR-0018.

## Assessment line

"Validate ... not taken"; "Once booked the slot must not be available to others".

## Review trigger

Variable slot durations, or a clinic in a non-half-hour offset such as +05:45. Either one means migrating to option 2. Before that, check `SELECT name FROM pg_available_extensions WHERE name='btree_gist'` on Neon.

**Verified 2026-10-18 on the live Neon project:** `pg_available_extensions` lists `btree_gist` 1.7, but it is not installed; the installed extensions are `plpgsql` and `citext` only. The double-booking guard that is built is the partial unique btree index `uq_appt_doctor_slot_booked` on `appointments (doctor_id, starts_at) WHERE status = 'booked'`, plus `uq_appt_patient_slot_booked` on `(patient_id, starts_at)`. Neither needs `btree_gist`; only the exclusion-constraint alternative (option 2) would, and it is available on Neon if that migration is ever needed.
