# ADR-0006: Error model (RFC 9457 problem details) and status rule

- Date: 2026-10-16
- Deciders: engineering
- Catalogue: `docs/api-errors.md` (tested against code)

## Status

Accepted

**Build status (2026-10-18, main 748d7d8): Shipped (#31).** The RFC 9457 model, the closed code catalogue and its exhaustiveness test are in, including the auth, access and idempotency codes.

## Context

The brief asks for "meaningful errors + correct HTTP status codes". Clients need a stable, machine-readable code, not prose.

## Considered options

1. Ad hoc `{"detail": "..."}`, which is FastAPI's default.
2. RFC 9457 `application/problem+json` with a closed catalogue of codes.
3. A custom error envelope.

## Decision

Option 2.

- **Shape:** every non-2xx is `{type, title, status, detail, instance, code, request_id, errors}`.
- **Resolvable types:** `type` is `{PUBLIC_BASE_URL}/problems/<slug>`, and `GET /problems/{slug}` returns that entry.
- **Domain errors:** a closed hierarchy `DomainError(code, status, title, slug)`, mapped by one exception handler.
- **Framework errors:** Starlette 404/405 and `RequestValidationError` are re-wrapped into the same shape.
- **500s:** the body is opaque. The trace is logged under `request_id`, without bound parameters.
- **In the schema:** `code` is an enum, so generated clients get an exhaustive union.

**Status rule (copied verbatim into the README).** 404 means the resource in the path doesn't exist. 422 means the request is well-formed but semantically invalid, and resending it unchanged can never succeed. 409 means it conflicts with the current state and might succeed later.

| Code | Status | When |
|---|---|---|
| UNAUTHENTICATED | 401 | The internal assertion is missing, malformed, expired or does not match the request. |
| FORBIDDEN | 403 | The internal assertion is valid but its role may not use this endpoint. |
| VALIDATION_ERROR | 422 | schema or type errors, extra fields, bad UUID/date, non-string datetime |
| TIMEZONE_REQUIRED | 422 | naive datetime (and nothing else wrong) |
| UNKNOWN_DOCTOR / UNKNOWN_PATIENT | 422 | the body references a non-existent or inactive entity |
| SLOT_IN_PAST | 422 | starts_at <= now |
| BOOKING_TOO_SOON | 422 | now < starts_at < now + 60 min |
| DATE_OUT_OF_RANGE | 422 | clinic-local date > today + 90 |
| SLOT_MISALIGNED | 422 | off the 30-minute grid of a window, or seconds/µs ≠ 0 |
| OUTSIDE_WORKING_HOURS | 422 | [start, start + 30 min) not inside a window |
| IDEMPOTENCY_KEY_REUSED | 422 | The Idempotency-Key was already used with a different doctor or time. |
| SLOT_TAKEN | 409 | `uq_appt_doctor_slot_booked` |
| PATIENT_DOUBLE_BOOKED | 409 | `uq_appt_patient_slot_booked` |
| APPOINTMENT_ALREADY_CANCELLED | 409 | cancel or reschedule of a cancelled appointment |
| CHANGE_TOO_LATE | 409 | changing or cancelling a visit that starts within 60 minutes (ADR-0008 amendment) |
| APPOINTMENT_ALREADY_STARTED | 409 | cancel or reschedule when starts_at <= now |
| PATIENT_PHONE_EXISTS | 409 | `uq_patients_phone` |
| CONCURRENT_UPDATE | 409 | deadlock or serialization failure that persists after one retry |
| IDEMPOTENCY_KEY_CONSUMED | 409 | The Idempotency-Key belongs to an appointment that is no longer booked. |
| ACCESS_EXISTS | 409 | This email already has active access; change its role instead. |
| OWNER_PROTECTED | 409 | The owner's access is fixed by configuration and cannot be granted, changed or revoked. |
| DOCTOR_NOT_FOUND / PATIENT_NOT_FOUND / APPOINTMENT_NOT_FOUND / PROBLEM_NOT_FOUND / NOT_FOUND | 404 | path resource unknown |
| METHOD_NOT_ALLOWED | 405 | Starlette |
| ACCESS_NOT_FOUND | 404 | No active access for this email. |
| DB_UNAVAILABLE | 503 | connection failure or pool timeout (+ `Retry-After: 2`) |
| INTERNAL_ERROR | 500 | fallback; any `ck_*` violation lands here as a bug |

**Amendment (2026-10-18): the table now lists the auth, access and idempotency codes.** Seven codes were added to the table above: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `ACCESS_EXISTS` (409), `OWNER_PROTECTED` (409), `ACCESS_NOT_FOUND` (404), and `IDEMPOTENCY_KEY_REUSED` and `IDEMPOTENCY_KEY_CONSUMED`, whose rows already existed. The "When" wording of these rows is copied from the detail column of `docs/api-errors.md` as merged in PR #31, which is the authority. For the two idempotency rows that replaces the shorter ADR wording ("same key, different payload"; "key replayed after the appointment left `booked`") and drops the "(T2)" tag; the statuses (422 and 409) are unchanged. All seven codes are on `main` (PR #31 added the idempotency ones).

## Consequences

- Good: every failure can be told apart by `code`, and every `code` is documented and tested.
- Bad (a stated deviation from "errors are values"): in FastAPI, a typed exception hierarchy with a single mapping point is the idiomatic equivalent. `tests/unit/test_error_catalogue.py` checks exhaustiveness against `docs/api-errors.md`.

## Assessment line

"Meaningful errors + correct HTTP status codes".

## Review trigger

A client that needs localized messages. That means i18n of `title`, keyed by `code`.

## Amendment (2026-10-19): which code fires for the one-hour rule

`BOOKING_TOO_SOON` (422) is for a too-soon slot: a booking, or a reschedule's new time, validated as for a fresh booking. `CHANGE_TOO_LATE` (409) is for changing or cancelling a visit whose current start is within the hour. A too-soon new time can only get worse, so it is a 422; the visit's nearness is state that changes the answer over time, so it is a 409. See [ADR-0008](0008-appointment-lifecycle-and-reschedule.md).
