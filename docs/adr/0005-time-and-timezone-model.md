# ADR-0005: Time and timezone model

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (audit 2026-10-17): Built, one gap.** UTC storage, the injected clock, the ruff time bans and the Berlin DST tests are in. Response datetimes are rendered in a hardcoded Nairobi zone, so a second clinic still needs a code change; being changed in PR #31 (not merged yet).

## Context

"A patient sees free slots ... on a day." A day only means something in a timezone. "Not in past" needs a single clock that tests can control.

## Considered options

1. Timezone held in environment config.
2. Local naive timestamps in storage.
3. UTC `timestamptz` storage, the clinic's IANA zone stored as data, and an injected clock.

## Decision

Option 3.

- **Zone as data:** `clinics.timezone`, seeded as `Africa/Nairobi`.
- **Input:** an RFC 3339 string with an offset.
  - A naive string → 422 `TIMEZONE_REQUIRED`, returned only when every validation error is `timezone_aware`.
  - A number → 422 `VALIDATION_ERROR`, via a str-only `BeforeValidator`.
- **Output:** in the clinic offset, plus a `timezone` field.
- **Wall-time conversion:** `zoneinfo` with `datetime.combine`. Times that don't round-trip are dropped. Slot generation steps in UTC and dedupes, which handles DST fall-back.
- **Day bounds:** availability uses the clinic-local day as the UTC range `[D 00:00, D+1 00:00)`, and the weekday comes from the local date.
- **Clock:** a `Clock` protocol injected through a FastAPI dependency. Tests use `FakeClock(2026-10-19T04:00Z)`, which is Monday 07:00 EAT.
- **Banned time APIs:** ruff bans `datetime.now`, `utcnow`, `datetime.today`, `date.today` and `time.time` everywhere except `core/clock.py`.
- **SQL:** business SQL never calls `now`. The current instant is always a bind parameter.

## Consequences

- Good: a second clinic needs no code change.
- Good: tests are deterministic and independent of the weekday they run on.
- Bad: one extra join to read the clinic's zone.
- Bad: DST tests run in `Europe/Berlin` (spring-forward and fall-back) even though Nairobi has no DST, so the code is proven for zones we don't serve yet.

**Amendment (2026-10-18), pending the merge of PR #31.** Each response renders datetimes in its own doctor's clinic timezone (`clinics.timezone`). `DEFAULT_CLINIC_TZ` is used only when there is no clinic. The hard-coded Nairobi zone is gone, so a second clinic no longer needs a code change.

## Assessment line

"On a day"; "not in past".

## Review trigger

A second clinic in a DST zone.
