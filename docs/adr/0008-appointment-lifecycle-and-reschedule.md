# ADR-0008: Appointment lifecycle, reschedule atomicity and concurrent-update handling

- Date: 2026-10-16
- Deciders: engineering

## Status
Accepted

## Context
Reschedule must free the old slot and validate the new one "like fresh booking", and it must error if the appointment is cancelled. Concurrent cancels, reschedules and swaps must never produce two booked rows or a 5xx.

## Considered options
1. Cancel the old row and insert a new one.
2. A conditional UPDATE without a lock.
3. `SELECT ... FOR UPDATE`, guards, the shared validator, then one in-place UPDATE.

## Decision
Option 3.
- **States:** `booked → cancelled` (terminal). A reschedule is `booked → booked` with a new `starts_at`, and the id stays the same.
- **Order of steps:** lock → 404 → 409 cancelled → 409 started → same-start no-op (200) → doctor active → the same `validate_slot` used for booking → UPDATE → INSERT `appointment_events` → COMMIT.
- **Atomicity:** a single UPDATE frees the old slot and claims the new one. The partial index re-checks it atomically. On a 23505 the whole transaction rolls back and the original booking is untouched.
- **Deadlocks:** two appointments swapping slots can deadlock (SQLSTATE 40P01). The service retries the whole transaction once with 20-80 ms of jitter, then returns 409 `CONCURRENT_UPDATE`. A 40001 is handled the same way.

## Consequences
- Good: single-row reasoning, a stable id, and no 503 for what is really a state conflict.
- Bad: a swap may end with both requests getting 409 and the original state kept. We accept that, and race case 7 asserts it.

## Assessment line
"Old slot freed, new slot validated like fresh booking; error if cancelled"; "slot bookable again".

## Review trigger
Attendance tracking. That means adding `completed` and `no_show` states.
