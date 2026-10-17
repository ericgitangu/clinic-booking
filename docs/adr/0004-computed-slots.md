# ADR-0004: Slots are computed, not materialized

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (audit 2026-10-17): Built.** Slots come from a pure function over working hours, booked starts and a lead time. Slot length is a module constant, not a parameter as the text shows; being changed in PR #31 (not merged yet).

## Context

The brief says: "Each doctor has set working hours and works in 30-minute slots."

## Considered options

1. Compute slots: take the working windows, cut them into 30-minute steps, and subtract booked starts and anything before `now + lead`.
2. A materialized `slots` table filled by a generator cron.
3. An RRULE recurrence engine.

## Decision

Option 1.

- **Function:** `domain/slots.py::generate_slots(windows, booked_starts, tz, local_date, now, lead, slot=30min)` is a pure function.
- **Algorithm:** it steps in UTC from the window-start instant to the window-end instant, then dedupes.
- **Queries per request:** one indexed query for the booked starts in the clinic-local day's UTC bounds, and one for the windows.

## Consequences

- Good: working hours are the only source of truth, and a change to them takes effect immediately.
- Good: at most 48 iterations per request.
- Bad: uniqueness has to come from the appointments constraint (ADR-0003). There is no slot row to lock.

**Amendment (2026-10-18), pending the merge of PR #31.**

- The slot length is a parameter of the pure domain function, and the function filters candidate slots against booked **intervals** by overlap, not by exact start.
- The public API always uses the brief's fixed 30-minute slot: the same constant the booking path and the database checks use.
- A public `slot_minutes` parameter was tried in PR #31 and removed, because it advertised slots that booking rejected or booked at a different length.
- Per-clinic slot lengths would need a new column, parameterised checks and an exclusion constraint. The exclusion constraint needs `btree_gist`, which is available on Neon but not installed ([ADR-0003](0003-double-booking-partial-unique-index.md)). That is the review trigger.

## Assessment line

The working-hours sentence; "Starting small but want to grow".

## Review trigger

A cross-doctor search ("any doctor free at X") with 50 or more doctors. That calls for one batched query over a `doctor_id` array to avoid N+1.
