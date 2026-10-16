# API error catalogue

Generated to match `backend/app/domain/errors.py` and tested against it
(`tests/unit/test_error_catalogue.py`). Do not edit by hand; update the catalogue in
code and regenerate. `type` is `{PUBLIC_BASE_URL}/problems/<slug>`.

**Status rule.** 404 = the path resource does not exist. 422 = well-formed but
semantically invalid; resending unchanged can never succeed. 409 = conflicts with the
current state; may succeed later or in another state.

| Code | Status | Slug | Title | When |
|---|---|---|---|---|
| VALIDATION_ERROR | 422 | validation-error | Validation error | Schema or type errors, extra fields, bad UUID/date, non-string datetime. |
| TIMEZONE_REQUIRED | 422 | timezone-required | Timezone required | The datetime is naive (and nothing else is wrong). |
| UNKNOWN_DOCTOR | 422 | unknown-doctor | Unknown doctor | The body references a non-existent or inactive doctor. |
| UNKNOWN_PATIENT | 422 | unknown-patient | Unknown patient | The body references a non-existent patient. |
| SLOT_IN_PAST | 422 | slot-in-past | Slot in the past | starts_at is at or before now. |
| BOOKING_TOO_SOON | 422 | booking-too-soon | Booking too soon | starts_at is less than the minimum lead time ahead of now. |
| DATE_OUT_OF_RANGE | 422 | date-out-of-range | Date out of range | The clinic-local date is beyond the booking horizon. |
| SLOT_MISALIGNED | 422 | slot-misaligned | Slot misaligned | Off the 30-minute grid of a window, or seconds/microseconds are non-zero. |
| OUTSIDE_WORKING_HOURS | 422 | outside-working-hours | Outside working hours | [start, start + 30 min) is not inside a working window. |
| SLOT_TAKEN | 409 | slot-taken | Slot taken | Another booking holds this doctor slot (uq_appt_doctor_slot_booked). |
| PATIENT_DOUBLE_BOOKED | 409 | patient-double-booked | Patient double-booked | The patient already has a booking at this time (uq_appt_patient_slot_booked). |
| APPOINTMENT_ALREADY_CANCELLED | 409 | appointment-already-cancelled | Appointment already cancelled | Cancel or reschedule of an already-cancelled appointment. |
| APPOINTMENT_ALREADY_STARTED | 409 | appointment-already-started | Appointment already started | Cancel or reschedule when starts_at is at or before now. |
| PATIENT_PHONE_EXISTS | 409 | patient-phone-exists | Patient phone exists | Another patient already uses this phone (uq_patients_phone). |
| CONCURRENT_UPDATE | 409 | concurrent-update | Concurrent update | A deadlock or serialization failure persisted after one retry. |
| DOCTOR_NOT_FOUND | 404 | doctor-not-found | Doctor not found | No such doctor (including inactive). |
| PATIENT_NOT_FOUND | 404 | patient-not-found | Patient not found | No such patient. |
| APPOINTMENT_NOT_FOUND | 404 | appointment-not-found | Appointment not found | No such appointment. |
| PROBLEM_NOT_FOUND | 404 | problem-not-found | Problem not found | No such problem slug. |
| NOT_FOUND | 404 | not-found | Not found | The path resource does not exist. |
| METHOD_NOT_ALLOWED | 405 | method-not-allowed | Method not allowed | The method is not allowed on this path. |
| DB_UNAVAILABLE | 503 | db-unavailable | Database unavailable | Connection failure or pool timeout. Retry after a short delay. |
| INTERNAL_ERROR | 500 | internal-error | Internal error | An unexpected error. Any ck_* violation lands here as a bug. |

T2 codes (`IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_CONSUMED`) are added by WP-14.
Stretch codes are added by their owning WP (§6).
