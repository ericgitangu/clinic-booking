# API error catalogue

Generated to match `backend/app/domain/errors.py` and tested against it
(`tests/unit/test_error_catalogue.py`). Do not edit by hand; update the catalogue in
code and regenerate. `type` is `{PUBLIC_BASE_URL}/problems/<slug>`.

**Status rule.** 404 = the path resource does not exist. 422 = well-formed but
semantically invalid; resending unchanged can never succeed. 409 = conflicts with the
current state; may succeed later or in another state.

| Code | Status | Slug | Title | When |
|---|---|---|---|---|
| UNAUTHENTICATED | 401 | unauthenticated | Unauthenticated | The internal assertion is missing, malformed, expired or does not match the request. |
| FORBIDDEN | 403 | forbidden | Forbidden | The internal assertion is valid but its role may not use this endpoint. |
| CLIENT_ADDRESS_UNKNOWN | 400 | client-address-unknown | Client address unknown | The request carries no usable client address, so it cannot be rate limited. Retry. |
| VALIDATION_ERROR | 422 | validation-error | Validation error | Schema or type errors, extra fields, bad UUID/date, non-string datetime. |
| TIMEZONE_REQUIRED | 422 | timezone-required | Timezone required | The datetime is naive (and nothing else is wrong). |
| UNKNOWN_DOCTOR | 422 | unknown-doctor | Unknown doctor | The body references a non-existent or inactive doctor. |
| UNKNOWN_PATIENT | 422 | unknown-patient | Unknown patient | The body references a non-existent patient. |
| SLOT_IN_PAST | 422 | slot-in-past | Slot in the past | starts_at is at or before now. |
| BOOKING_TOO_SOON | 422 | booking-too-soon | Booking too soon | starts_at is less than the minimum lead time ahead of now. |
| DATE_OUT_OF_RANGE | 422 | date-out-of-range | Date out of range | The clinic-local date is beyond the booking horizon. |
| SLOT_MISALIGNED | 422 | slot-misaligned | Slot misaligned | Off the 30-minute grid of a window, or seconds/microseconds are non-zero. |
| OUTSIDE_WORKING_HOURS | 422 | outside-working-hours | Outside working hours | [start, start + 30 min) is not inside a working window. |
| IDEMPOTENCY_KEY_REUSED | 422 | idempotency-key-reused | Idempotency key reused | The Idempotency-Key was already used with a different doctor or time. |
| SLOT_TAKEN | 409 | slot-taken | Slot taken | Another booking holds this doctor slot (uq_appt_doctor_slot_booked). |
| PATIENT_DOUBLE_BOOKED | 409 | patient-double-booked | Patient double-booked | The patient already has a booking at this time (uq_appt_patient_slot_booked). |
| APPOINTMENT_ALREADY_CANCELLED | 409 | appointment-already-cancelled | Appointment already cancelled | Cancel or reschedule of an already-cancelled appointment. |
| APPOINTMENT_ALREADY_STARTED | 409 | appointment-already-started | Appointment already started | Cancel or reschedule when starts_at is at or before now. |
| PATIENT_PHONE_EXISTS | 409 | patient-phone-exists | Patient phone exists | Another patient already uses this phone (uq_patients_phone). |
| CONCURRENT_UPDATE | 409 | concurrent-update | Concurrent update | A deadlock or serialization failure persisted after one retry. |
| RATE_LIMITED | 429 | rate-limited | Rate limited | Too many requests from this address. Wait for Retry-After seconds and try again. |
| IDEMPOTENCY_KEY_CONSUMED | 409 | idempotency-key-consumed | Idempotency key consumed | The Idempotency-Key belongs to an appointment that is no longer booked. |
| ACCESS_EXISTS | 409 | access-exists | Access exists | This email already has active access; change its role instead. |
| OWNER_PROTECTED | 409 | owner-protected | Owner protected | The owner's access is fixed by configuration and cannot be granted, changed or revoked. |
| ACCESS_NOT_FOUND | 404 | access-not-found | Access not found | No active access for this email. |
| DOCTOR_NOT_FOUND | 404 | doctor-not-found | Doctor not found | No such doctor (including inactive). |
| PATIENT_NOT_FOUND | 404 | patient-not-found | Patient not found | No such patient. |
| APPOINTMENT_NOT_FOUND | 404 | appointment-not-found | Appointment not found | No such appointment. |
| PROBLEM_NOT_FOUND | 404 | problem-not-found | Problem not found | No such problem slug. |
| NOT_FOUND | 404 | not-found | Not found | The path resource does not exist. |
| METHOD_NOT_ALLOWED | 405 | method-not-allowed | Method not allowed | The method is not allowed on this path. |
| REALTIME_UNAVAILABLE | 503 | realtime-unavailable | Realtime unavailable | Live updates are off (not configured, or this month's publish budget is spent). Poll. |
| DB_UNAVAILABLE | 503 | db-unavailable | Database unavailable | Connection failure or pool timeout. Retry after a short delay. |
| INTERNAL_ERROR | 500 | internal-error | Internal error | An unexpected error. Any ck_* violation lands here as a bug. |

Idempotency (ADR-0013): `Idempotency-Key` is read on `POST /appointments` and
`POST /internal/me/appointments`, scoped to the patient. The same key with the same doctor and
time replays the booking with `Idempotent-Replayed: true`; a different doctor or time is
`IDEMPOTENCY_KEY_REUSED`; a key whose appointment has left `booked` is
`IDEMPOTENCY_KEY_CONSUMED`. A malformed key (not 1-255 visible ASCII characters) is
`VALIDATION_ERROR`.

Realtime tokens (`POST /realtime/token/patient`, `POST /internal/realtime/token/admin`): `CLIENT_ADDRESS_UNKNOWN`
(400) when the proxy supplied no usable `x-client-ip` (the API never guesses one from the socket); `RATE_LIMITED` (429, with
`Retry-After`) when an address uses too many tokens in a minute or a day; `REALTIME_UNAVAILABLE` (503) when push is not
configured or the month's publish budget is spent, so the client polls.

Declared by [ADR-0033](adr/0033-staff-crud-veto-and-invites.md), not yet emitted (staff CRUD, veto and invites are
pending build). These are bullets, not table rows, because the catalogue test requires the table and `CATALOGUE` to match
exactly, and a documented code with no code behind it would fail it. The backend change that adds the code to
`backend/app/domain/errors.py` and the `ProblemCode` enum moves its entry into the table above in the same commit,
with the slug and title given here. `ACCESS_EXISTS` and `OWNER_PROTECTED` are already in the table and are reused.

- `ROLE_ESCALATION` (403, slug `role-escalation`, title "Role escalation"). Fires when an admin tries to change or revoke
  an admin, or when anyone changes their own access row. The client should not retry; ask the owner.
- `APPOINTMENT_LOCKED` (409, slug `appointment-locked`, title "Appointment locked"). Fires when a patient books,
  cancels or reschedules on a lineage that staff vetoed and locked. The client should show that the clinic has to be
  contacted; resending cannot succeed until an admin unlocks.
- `NOTHING_TO_VETO` (409, slug `nothing-to-veto`, title "Nothing to veto"). Fires when staff veto an appointment that
  has no patient change to reverse. The client should refresh the appointment and its history.
- `INVITE_INVALID` (404, slug `invite-invalid`, title "Invite invalid"). Fires for every failed accept (unknown,
  reused, expired, revoked, or a Google email that is not the invited one) with an identical body, so a caller cannot
  tell which. The client should show one generic message and ask the owner or admin for a new invite.

Every code the API can emit is in this table: `tests/unit/test_error_catalogue.py` checks the
domain error classes, the codes named in the handlers, the `ProblemCode` enum in the contract
and this file against `CATALOGUE`.
Stretch codes are added by their owning feature.
