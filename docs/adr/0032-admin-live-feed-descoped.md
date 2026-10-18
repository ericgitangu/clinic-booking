# ADR-0032: The admin live feed is descoped for this submission

- Date: 2026-10-18
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0009](0009-realtime-polling-now-sse-later.md), [ADR-0031](0031-realtime-push-via-ably-sse.md)

## Status

Accepted, decided by the engineer 2026-10-18.

**Build status (2026-10-18, main 4aef3b8): Descoped.** The admin dashboard uses server revalidation and the refresh button, as the first version of ADR-0010 specified. The `admin:events` channel is defined in the event contract (PR #39, open) but nothing in the admin app subscribes to it.

## Context

ADR-0009 and ADR-0031 give the admin dashboard a live feed: the server publishes admin events to Ably and the dashboard subscribes. The booking page is the place where a stale slot costs a patient a failed booking, so patient push comes first. The admin feed shows aggregates to one or two staff, who can press refresh, and a stale chart costs nobody a booking.

## Considered options

1. Build the admin subscriber now, next to the booking hook.
2. Descope it for this submission and keep server revalidation.
3. Poll the admin endpoints from the browser.

## Decision

Option 2. The reason is time and budget, not capability: the Ably channel and the token endpoint for admins can serve it, and nothing in the design blocks adding it later.

- The admin dashboard keeps its cached metrics (60 seconds, refreshed by the button) from PR #30.
- The server may still publish admin events now that PR #39 has merged. They cost messages against the Ably budget (ADR-0031) and nothing consumes them, so I will count that in the usage check and can turn the admin publish off if it matters.
- Option 3 is rejected: a polling loop in the dashboard would keep the database awake for a feature I am not building.

## Consequences

- Good: less to build and test before the submission, and no extra connections against the 200-connection free limit.
- Bad: the dashboard can be up to 60 seconds behind until someone presses refresh.
- Bad: the admin publish path may carry events that nobody reads. Cheap, but not free, so the review trigger below covers it.

## Assessment line

Section 1 "key decisions, trade-offs": what I chose not to build and why.

## Review trigger

A requirement for staff to watch bookings arrive without refreshing, or Ably usage showing the unused admin publishes matter. Then build the subscriber from the existing hook.
