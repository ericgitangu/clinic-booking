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
| ASSERTION_REPLAYED | 401 | assertion-replayed | Assertion replayed | This signed request was already used once. Sign a new one for each write. |
| ROLE_ESCALATION | 403 | role-escalation | Role escalation | The caller's role may not change this access: an admin cannot change or revoke an admin, and nobody changes their own access. |
| CLIENT_ADDRESS_UNKNOWN | 400 | client-address-unknown | Client address unknown | The request carries no usable client address, so it cannot be rate limited. Retry. |
| VALIDATION_ERROR | 422 | validation-error | Validation error | Schema or type errors, extra fields, bad UUID/date, non-string datetime. |
| TIMEZONE_REQUIRED | 422 | timezone-required | Timezone required | The datetime is naive (and nothing else is wrong). |
| UNKNOWN_DOCTOR | 422 | unknown-doctor | Unknown doctor | The body references a non-existent or inactive doctor. |
| UNKNOWN_PATIENT | 422 | unknown-patient | Unknown patient | The body references a non-existent patient. |
| SLOT_IN_PAST | 422 | slot-in-past | Slot in the past | starts_at is at or before now. |
| BOOKING_TOO_SOON | 422 | booking-too-soon | Booking too soon | A booking, or a reschedule's new time, starts less than the minimum lead time (BOOKING_MIN_LEAD_MINUTES, 60 by default) ahead of now. |
| DATE_OUT_OF_RANGE | 422 | date-out-of-range | Date out of range | The clinic-local date is beyond the booking horizon. |
| SLOT_MISALIGNED | 422 | slot-misaligned | Slot misaligned | Off the 30-minute grid of a window, or seconds/microseconds are non-zero. |
| OUTSIDE_WORKING_HOURS | 422 | outside-working-hours | Outside working hours | [start, start + 30 min) is not inside a working window. |
| IDEMPOTENCY_KEY_REUSED | 422 | idempotency-key-reused | Idempotency key reused | The Idempotency-Key was already used with a different doctor or time. |
| SLOT_TAKEN | 409 | slot-taken | Slot taken | Another booking holds this doctor slot (uq_appt_doctor_slot_booked). |
| PATIENT_DOUBLE_BOOKED | 409 | patient-double-booked | Patient double-booked | The patient already has a booking at this time (uq_appt_patient_slot_booked). |
| APPOINTMENT_ALREADY_CANCELLED | 409 | appointment-already-cancelled | Appointment already cancelled | Cancel or reschedule of an already-cancelled appointment. |
| CHANGE_TOO_LATE | 409 | change-too-late | Change too late | Changing or cancelling a visit that starts less than the minimum lead time (BOOKING_MIN_LEAD_MINUTES, 60 by default) from now. A reschedule's new time is BOOKING_TOO_SOON instead. |
| APPOINTMENT_ALREADY_STARTED | 409 | appointment-already-started | Appointment already started | Cancel or reschedule when starts_at is at or before now. |
| PATIENT_PHONE_EXISTS | 409 | patient-phone-exists | Patient phone exists | Another patient already uses this phone (uq_patients_phone). |
| CONCURRENT_UPDATE | 409 | concurrent-update | Concurrent update | A deadlock or serialization failure persisted after one retry. |
| RATE_LIMITED | 429 | rate-limited | Rate limited | Too many requests from this address, or too many staff changes by this person in the current window. Wait for Retry-After seconds and try again. |
| IDEMPOTENCY_KEY_CONSUMED | 409 | idempotency-key-consumed | Idempotency key consumed | The Idempotency-Key belongs to an appointment that is no longer booked. |
| APPOINTMENT_LOCKED | 409 | appointment-locked | Appointment locked | Staff vetoed the last change to this appointment, so it can only be changed by staff until an owner or admin unlocks it. |
| ATTENDANCE_WINDOW_CLOSED | 409 | attendance-window-closed | Attendance window closed | Arrival can be recorded from 15 minutes before the appointment to 2 hours after it starts, no-show from the start to 2 hours after, and neither outside that. |
| NOTHING_TO_VETO | 409 | nothing-to-veto | Nothing to veto | The appointment's latest change was not made by the patient (or is already undone), or an unlock was asked for an appointment that is not locked. |
| ACCESS_EXISTS | 409 | access-exists | Access exists | This email already has active access; change its role instead. |
| OWNER_PROTECTED | 409 | owner-protected | Owner protected | The owner's access is fixed by configuration and cannot be granted, changed or revoked. |
| INVITE_INVALID | 404 | invite-invalid | Invite invalid | The invitation does not exist, was used, revoked or expired, or was sent to another email. Every reason returns the same body. |
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

Idempotency: `Idempotency-Key` is read on `POST /appointments` and
`POST /internal/me/appointments`, scoped to the patient. The same key with the same doctor and
time replays the booking with `Idempotent-Replayed: true`; a different doctor or time is
`IDEMPOTENCY_KEY_REUSED`; a key whose appointment has left `booked` is
`IDEMPOTENCY_KEY_CONSUMED`. A malformed key (not 1-255 visible ASCII characters) is
`VALIDATION_ERROR`.

Realtime tokens (`POST /realtime/token/patient`, `POST /internal/realtime/token/admin`): `CLIENT_ADDRESS_UNKNOWN`
(400) when the proxy supplied no usable `x-client-ip` (the API never guesses one from the socket); `RATE_LIMITED` (429, with
`Retry-After`) when an address uses too many tokens in a minute or a day; `REALTIME_UNAVAILABLE` (503) when push is not
configured or the month's publish budget is spent, so the client polls.

Every code the API can emit is in this table: `tests/unit/test_error_catalogue.py` checks the
domain error classes, the codes named in the handlers, the `ProblemCode` enum in the contract
and this file against `CATALOGUE`.
Stretch codes are added by their owning feature.

## CHANGE_TOO_LATE (409)

The one-hour rule for changes. `PATCH /appointments/{id}/cancel` and
`PATCH /appointments/{id}/reschedule` (and their `/internal/me` and `/internal/admin` forms) are
refused with this code when the appointment's current start is less than 60 minutes away
(`BOOKING_MIN_LEAD_MINUTES`); exactly 60 minutes away is allowed. Staff are exempt: the staff
routes never return it (they still return every other refusal). It fires after the not-found, already-cancelled and already-started checks, and a repeat of
a reschedule that already happened (same new start) still returns the appointment.

What a client should do: do not retry, and do not offer cancel or reschedule for an appointment
inside the window. Tell the person in plain words that the visit is too close to change in the app and to
call the clinic (a phone call is how a patient changes a visit that close; the staff routes do not apply this rule).

The contract in one line: **`422 BOOKING_TOO_SOON` on book and on a reschedule's new start (a new
time is validated as a fresh booking); `409 CHANGE_TOO_LATE` on cancel and on a reschedule's current
start.**
