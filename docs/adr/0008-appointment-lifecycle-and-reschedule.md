# ADR-0008: Appointment lifecycle, reschedule atomicity and concurrent-update handling

- Date: 2026-10-16
- Deciders: engineering
- Amended by: [ADR-0033](0033-staff-crud-veto-and-invites.md), 2026-10-18: staff are exempt from the lead-time rules, a staff veto sets a lock that follows reschedules and blocks patient changes with `APPOINTMENT_LOCKED`, and an undone cancel is a new appointment linked by lineage. Pending build.

## Status

Accepted

**Build status (2026-10-18, main 748d7d8): Shipped.** Reschedule is an in-place UPDATE under a row lock, with one jittered retry on deadlock or serialization failure and a 409 `CONCURRENT_UPDATE` after that. Race and deadlock tests cover it.

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

## Amendment (2026-10-18): the one-hour rule applies to every change

Decided by the engineer on 2026-10-18. The brief's bonus is "prevention of bookings within 1 hour of now": the code applied it to a new booking and to a reschedule's new time. Cancel and reschedule refused only once `starts_at <= now`, so a patient could still cancel or move a visit that begins in ten minutes. Extending the lead time to those changes is the engineer's addition to the bonus, not brief text.

- **The rule.** An operation is refused when the appointment it acts on starts less than `BOOKING_MIN_LEAD_MINUTES` (60) from now. Exactly 60 minutes away is allowed. One helper, `domain/booking_rules.py::require_lead_time`, implements it; `validate_slot` (book, and a reschedule's new time, as `BOOKING_TOO_SOON`) and the cancel and reschedule services (the current start, as `CHANGE_TOO_LATE`) all call it.
- **Operations.** Book: `422 BOOKING_TOO_SOON` (unchanged). Cancel: new `409 CHANGE_TOO_LATE`. Reschedule: `409 CHANGE_TOO_LATE` for the current start; its new start stays `422 BOOKING_TOO_SOON`, because the brief says the new slot is validated as for a fresh booking and a too-soon time can only get worse (README's status rule for 422). The contract in one line: **`422 BOOKING_TOO_SOON` on book and on a reschedule's new start; `409 CHANGE_TOO_LATE` on cancel and on a reschedule's current start.** Availability never offers a slot under 60 minutes away.
- **Order of steps.** lock, 404, 409 cancelled, 409 started, same-start no-op (200), then the lead-time check on the current start (`CHANGE_TOO_LATE`), then the new time's checks (`BOOKING_TOO_SOON` among them). The no-op comes first so a retry of a reschedule that already happened still returns the appointment. A replayed booking is answered before any validation ([ADR-0013](0013-idempotency-keys.md)). A repeated cancel still answers `APPOINTMENT_ALREADY_CANCELLED`.
- **Staff.** [ADR-0030](0030-staff-roles-and-access.md) says the admin cancel and reschedule apply the same booking rules as the public endpoints, so owners and admins are held to the rule too, with no override. Cancelling a visit that is minutes away is a phone call to the clinic, not a button.
- **Why 409 and a new code.** The appointment's state (how near it is) conflicts with the change, and the answer changes as time passes, which is the 409 meaning in [ADR-0006](0006-problem-details-error-model.md); `APPOINTMENT_ALREADY_STARTED` would be wrong and untrue before the start.
- **Trade-off accepted.** A patient who cannot attend a visit under an hour away can no longer free the slot themselves; the clinic can do nothing through the app either. The slot is lost for that day.
- **Both apps** disable cancel and reschedule inside the window, with a visible explanation tied to the disabled controls (`aria-describedby`).

**Note (2026-10-19): the staff exemption.** Staff are held to the one-hour rule today, with no override, because [ADR-0030](0030-staff-roles-and-access.md) gives staff the public booking rules. [ADR-0033](0033-staff-crud-veto-and-invites.md) decides that staff are exempt from the lead-time rules; that exemption is not built yet and lands with the staff-write work, so until then staff follow the rule.
