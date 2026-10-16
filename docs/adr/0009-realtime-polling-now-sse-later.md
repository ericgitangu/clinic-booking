# ADR-0009: Realtime: polling for patients; SSE via a Go gateway for admins as a gated stretch

- Date: 2026-10-16 (amended 2026-10-16: admin SSE moved from deferred to the gated stretch tier)
- Deciders: engineering
- Plan reference: [PLAN.md §3.7, §3.9](../architecture/PLAN.md#39-stretch-s1-realtime-admin-feed)

## Status
Accepted. This revision supersedes this ADR's own earlier decision to defer SSE entirely: patient polling is unchanged, and an admin-only SSE feed is stretch item S1, built only after Gate B (PLAN.md §0, §12.1).

## Context
- **What realtime would buy.** The database already guarantees correctness, so push would only improve UX: a competing patient would see a slot disappear before submitting, and clinic staff would see bookings land as they happen.
- **What it would cost.** SSE on Cloud Run with Neon Free needs a poller or LISTEN. Neon doesn't support LISTEN on the pooler, and a held session keeps compute awake.
- **Reconnects never stop.** EventSource reconnects automatically, so a visible tab streams forever. One open tab keeps an instance billed and Neon awake, against a 100 CU-hour monthly budget.
- **$0 rule (added 2026-10-16).** The connected-hours budget is now computed against the free tiers in PLAN.md §13: one stream costs 900 vCPU-s per connected hour at 0.25 vCPU, plus a held Vercel front-door function. The hidden-tab close and the 10-minute idle close are hard acceptance items, and if WP-S1c cannot show heartbeats flushing through the front door, S1 is cut and admins poll `/admin/metrics` like patients poll availability (a 10 s poll at about 100 ms bills roughly 1% of an open stream; deduced).
- **Streams can starve booking.** Each public stream holds a concurrency slot, so a script opening about 240 streams would starve POST /appointments if the streams lived on the API service.
- **Ordering.** `appointment_events.id` (identity) and `occurred_at` are assigned at write time, not commit time. A reader advancing on `id > last_id` (or on a time lookback) can skip a row whose transaction commits after a later one. Any stream needs a commit-safe cursor.
- **Who needs it.** Patients: availability correctness already comes from the unique index, and the 409 path handles a stale slot honestly, so push for patients is UX only. Admins: a live view of bookings is the one place where push is the feature rather than a nicety.

## Considered options
1. SSE in FastAPI with async generators, with an outbox table polled by one task per instance.
2. Postgres LISTEN/NOTIFY.
3. Upstash Redis pub/sub.
4. Client polling while the page is visible, with an idle stop.
5. A separate Go `net/http` SSE gateway reading `appointment_events` with a commit-safe cursor (ADR-0021).
6. A managed realtime service (Pusher, Ably).

## Decision
**Patients: option 4, unchanged.**
- **Polling:** TanStack Query `refetchInterval: 15000` (only while the document is visible) plus `refetchOnWindowFocus`.
- **Idle stop:** polling stops after 10 minutes without pointer or keyboard input, showing a "Paused, click to refresh" chip.
- **Lost race:** a 409 `SLOT_TAKEN` triggers "just taken" copy and a refetch.

**Admins: option 5, as gated stretch S1** (choice of Go and the alternatives in ADR-0021).
- **Source of truth:** `appointment_events`, written by FastAPI in the same transaction as every state change. Expand-only migration `0003_event_cursor` adds `txid xid8 NOT NULL DEFAULT pg_current_xact_id()` and an index on `(txid, id)`.
- **Commit-safe cursor:** the gateway reads only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(txid, id)`, in a single statement. Every transaction below the snapshot's `xmin` has finished, so those rows can no longer appear late. The SSE `id:` is `<txid>.<id>`, so resume from `Last-Event-ID` is exact. `GET /admin/metrics` returns the same horizon as its `cursor`, so live increments start exactly where the initial aggregates stop.
- **Polling the DB:** about once a second per instance, and only while at least one client is connected. The gateway opens its DB pool with the first subscriber and closes it when the count returns to 0, so an idle instance issues zero queries and holds zero connections. Neon does not suspend while connections are active; that it then suspends once the pool is closed is expected but **unverified** until WP-S1c's measurement.
- **Endpoint:** `GET /stream?cursor=` on the separate `clinic-realtime` Cloud Run service (scale-to-zero, max 2 instances, request timeout 300 s). Events `appointment.booked`, `appointment.cancelled`, `appointment.rescheduled`; payload versioned with `schema_version` (PLAN.md §6).
- **Payloads:** aggregate and non-PII only: `doctor_id`, slot starts, event type, `local_date` and `from_local_date` (so a reschedule across days routes to both), `occurred_at`. Never `appointment_id`, patient ids, names, phones or reasons. The `clinic_realtime` role cannot read `appointment_id` at all (column grant, ADR-0015).
- **Limits** (carried over from the earlier growth path and adjusted): 3 concurrent streams per IP and 50 per instance (429 / 503 with `Retry-After`); heartbeat comment every 15 s; the server sends `event: reconnect` and closes at about 290 s; the client closes on a hidden tab and after 10 minutes without interaction, mirroring the patient polling rule.
- **Plumbing:** a disconnect is detected through the request context; subscribers unregister on exit; a test asserts the subscriber count returns to 0 and that the poller issues no queries with no subscribers.
- **Exposure:** public until S3 ships (the payloads are safe to expose); ~~after S3 a 60 s signed stream ticket is required (ADR-0022)~~ a 60 s signed stream ticket is required from S1 on, and each ticket debits a monthly connected-seconds budget, because the idle close is client-side and was not a cost bound (hosting lock review, [PLAN.md §12.4](../architecture/PLAN.md#124-hosting-lock-review)); after S3 the ticket route also needs an admin Google token (ADR-0022).
- **Verification:** an out-of-order-commit integration test and a naive-cursor control (ADR-0018; the same scenario was reproduced by hand on a local PostgreSQL 17.11 on 2026-10-16: the naive `id` read showed the later row while the earlier one was still uncommitted, and the horizon read returned nothing, then both rows in order); a post-deploy SSE smoke (ADR-0016); a measured Neon consumption check (one dashboard tab, 30 minutes) published in the README.

**Patient availability stream: still deferred.** If it is ever built, it goes through the same gateway as `GET /doctors/{id}/availability/stream?date=`, with `slot.taken` routed by `local_date` and `slot.freed` by `coalesce(from_local_date, local_date)`, under the same limits.

**Rejected:** option 1 because streams on the API service share its concurrency with `POST /appointments` (the starvation risk above) and Python holds each idle stream more expensively than a goroutine; option 2 because it does not remove the need for the commit-safe cursor (NOTIFY is lost for anyone not connected, so reconnect catch-up still reads the table), it needs a trigger or a `pg_notify` call inside the booking transaction (which the stretch rules forbid touching), NOTIFY takes a global lock at commit that serializes committing writers, and LISTEN needs a dedicated session held open even with zero clients, which Neon's pooled endpoint does not support anyway. (The gateway does use a direct connection, but only while someone is watching; that is not the reason LISTEN loses); option 3 now, because a relay is unnecessary at 2 instances (it is the review trigger); option 6 because it adds a third-party account, keys and a data processor for a demo, and would still need our own commit-safe cursor to publish from.

## Consequences
- Good: patients keep zero always-on cost and no new failure modes; correctness never depends on push.
- Good: the admin stream cannot starve booking, cannot skip or duplicate events, and is expected to cost nothing while nobody watches (no subscribers means no queries and no open DB connection; the Neon side is measured in WP-S1c).
- Bad: a stale slot can be visible to a patient for up to 15 s. The 409 path covers it honestly.
- Bad: an admin event waits until every older open write transaction finishes (normally milliseconds; an abandoned transaction is cut off by `idle_in_transaction_session_timeout`).
- Bad: a second runtime and deploy unit (ADR-0021).
- If S1 is cut, this ADR's patient decision stands alone and the admin part is recorded as "designed, not shipped".

## Assessment line
"Once booked the slot must not be available to others" (made visible in the UI and to staff); Section 1 "components, key decisions, trade-offs".

## Review trigger
Patients: a measured rate of 409 `SLOT_TAKEN` on submits that users actually notice means the patient availability stream. Admins: more than 5 gateway instances, more than 500 concurrent streams, or a cursor query p95 above 50 ms means moving fan-out to a single relay (ADR-0021).
