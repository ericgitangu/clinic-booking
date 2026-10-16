# ADR-0004: Slots are computed, not materialized

- Date: 2026-10-16
- Deciders: engineering

## Status
Accepted

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

## Assessment line
The working-hours sentence; "Starting small but want to grow".

## Review trigger
A cross-doctor search ("any doctor free at X") with 50 or more doctors. That calls for one batched query over a `doctor_id` array to avoid N+1.
