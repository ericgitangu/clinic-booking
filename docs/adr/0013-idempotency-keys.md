# ADR-0013: Idempotency keys on POST /appointments

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted (T2, second item cut)

**Build status (audit 2026-10-17): Not built.** Cut for time. Only the CORS and proxy header passthrough exists: no key column, fingerprint, replay flow or error codes, and the booking client sends no key. A retried POST after a lost response still gets 409 `SLOT_TAKEN`.

## Context

A mobile client whose first POST succeeded but whose response was lost will retry. Without idempotency, the retry gets 409 `SLOT_TAKEN`. That tells the actual booker they lost the slot they hold.

## Considered options

1. No idempotency.
2. A separate idempotency-keys table that stores response bodies.
3. The key stored on the appointment row, with a request fingerprint.

## Decision

Option 3.

- **Columns:** `Idempotency-Key` (1-255 visible ASCII) is stored on `appointments.idempotency_key`, with `request_fingerprint` = sha256 of canonical JSON `{doctor_id, starts_at_utc}`.
- **Uniqueness:** `UNIQUE (patient_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.
- **Flow:**
  1. Pre-SELECT by `(patient_id, key)`.
     - Same fingerprint and still `booked` → 201 with the **current** representation (which may have been rescheduled since) and `Idempotent-Replayed: true`.
     - No longer booked → 409 `IDEMPOTENCY_KEY_CONSUMED`.
     - Different fingerprint → 422 `IDEMPOTENCY_KEY_REUSED`.
  2. On **any** 23505 during the insert, re-check the key before mapping to a 409, because Postgres may report the doctor-slot violation first.
- **Client:** the key is created once per booking dialog and reset on success.

## Consequences

- Good: no extra table, and keys live exactly as long as the booking.
- Bad: no stored response bodies, so the replay semantics are "current state". This is documented.

## Assessment line

"Once booked the slot must not be available to others": a retry must not report the real booker's own slot as taken.

## Review trigger

Idempotency needed on other mutations. At that point, move to a generic keys table with stored responses.
