# ADR-0021: A Go SSE gateway for the admin realtime feed (realtime gateway)

- Date: 2026-10-16
- Deciders: engineering

## Status

**Amended 2026-10-17: optional, and built only after the admin dashboard ([ADR-0010](0010-thin-nextjs-booking-ui.md)). The dashboard starts with server revalidation.**

Accepted (gated realtime gateway; built only after Gate B, cut last of the stretch items). It amends ADR-0002 (Go is now allowed for one read-only job, never in the write path) and implements the admin half of ADR-0009.

**Build status (2026-10-19): Built (PR 71).** The Go service `services/realtime`, its read-only role (migration `0014_realtime_reader_role`), the `go-quality` CI job, the `ship-realtime` job and the event contract exist, and the admin dashboard has a live-feed panel that streams from it. The stream carries staff actions too (veto, unlock, attendance, reminders, "running late", invitations), with who acted and why for owners and admins only: staff-only personal data that stays on GCP and is the reason this service exists. The appointment page holds a stream filtered to its appointment. Viewer minimisation is enforced in the gateway's query (ADR-0014 amendment of 2026-10-19).

**Reinstated (2026-10-19).** On 2026-10-18 this ADR was marked superseded by [ADR-0031](0031-realtime-push-via-ably-sse.md) (Ably for everyone) without the engineer's sign-off. The engineer reversed that on 2026-10-19. Ably stays for patient slot events, which carry no personal data. The staff feed carries patient names and cancellation reasons, so it stays inside Google Cloud.

**As built, where it differs from the Decision below:**

- *Who may connect.* Cloud Run admits only the admin app's service account (and the release smoke); the request carries the same signed staff assertion the API checks, verified in Go, and the role in it is re-read from `staff_access` on connect and every 30 s. There is no stream ticket and no monthly budget table.
- *Shapes.* Owners and admins get the staff shapes (`contracts/events/staff-event.v1.schema.json` and `staff-action.v1.schema.json`: the patient, reasons, who acted, the invited address), viewers the minimised `admin-event.v1` and `admin-action.v1` shapes. The viewer's query never selects a personal column; the role could, so that query is the boundary (ADR-0014, accepted debt).
- *Scaling.* `--min-instances 0 --max-instances 2 --concurrency 1 --cpu 0.25 --memory 256Mi --timeout 900`. Cloud Run requires concurrency 1 below 1 vCPU, so there are at most two live staff streams; a third client gets 429 with `Retry-After` and the dashboard refreshes every 30 s instead.
- *Lifetimes.* The server closes a stream at 290 s (Vercel Hobby caps the admin app's route at 300 s) and after 240 s without an event; the browser resumes from the last event id, and lets go of the stream after 5 minutes in a hidden tab.
- *Cost.* About 900 vCPU-seconds per connected hour at 0.25 vCPU (deduced); the measured figure is recorded by `scripts/ops/measure_realtime_cost.sh` after the first deploy.

## Context

- **The job.** Hold many long-lived, mostly idle HTTP connections and push a few small events to them. Read one table. Never write, never decide availability.
- **The platform.** Cloud Run, scale-to-zero, request-based billing (an open stream bills its instance for as long as it is open; ADR-0014 has the arithmetic), a 300 s request timeout we choose to set, Neon Free. LISTEN/NOTIFY is rejected on its merits in ADR-0009 (lossy, needs a change in the booking transaction, a global commit lock, a session held even with no clients), not only because Neon's pooled endpoint lacks it.
- **What the stream must guarantee.** No skipped and no duplicated events across reconnects, even when transactions commit out of order (ADR-0009's xid8 snapshot-horizon cursor).
- **What it must not do.** Starve `POST /appointments` of concurrency, keep Neon awake when nobody is watching, or expose PII.
- **The cost of a second language.** A second toolchain, image, CI job (tests, govulncheck, gosec, trivy), deploy job and set of conventions. ADR-0002 rejected Go for exactly that reason when nothing required it.

## Considered options

1. SSE inside FastAPI with async generators (same service, same image).
2. A separate Go service on stdlib `net/http` + pgx v5, its own Cloud Run service.
3. A managed realtime provider (Pusher or Ably) fed by FastAPI.
4. A separate Python (FastAPI/Starlette) streaming service.

## Decision

Option 2, as `services/realtime` (`clinic-realtime`).

- **Why Go for this specific job:**
  - Each idle stream is a parked goroutine (a few KB of stack) rather than an asyncio task plus a Python-level response object, so one small instance holds many more idle streams for the same memory. This is an engineering expectation, not a measurement; records the Cloud Run memory utilization observed during its 30-minute tab test in README section 10.
  - A static binary in a distroless image (expected well under 30 MB; measure with `docker image inspect --format '{{.Size}}'`) starts fast, which matters on a scale-to-zero service whose first request is a browser waiting for a stream.
  - The standard library covers HTTP, SSE framing, HMAC (Google sign-in) and structured logging; pgx v5 is the only runtime dependency. The supply-chain surface is small and govulncheck covers it.
- **Why a separate service at all** (this also rules out option 1): streams on their own Cloud Run service cannot consume `clinic-api` concurrency, so a stream flood cannot block booking. The service scales to zero independently and can be cut without touching the API.
- **Shape (as built, PR 71):** `GET /stream` (SSE; `?cursor=` or `Last-Event-ID` to resume, `?appointment=<uuid>` to filter to one appointment) and `GET /health` (no I/O). Cloud Run `--min-instances 0 --max-instances 2 --concurrency 1 --cpu 0.25 --memory 256Mi --execution-environment gen1 --cpu-boost --timeout 900`, request-based billing, region us-east4, `--no-allow-unauthenticated` with `run.invoker` for `clinic-admin` and `clinic-smoke` only (amended by the $0 audit: at 1 vCPU a dashboard held 8 h a day for a week passes the monthly CPU allowance on its own; at 0.25 vCPU it uses about 28%; [ADR-0014](0014-hosting-region-and-cost.md) has the arithmetic). The monthly stream budget the hosting lock review proposed was not built: the bound is the gateway's own closes (290 s lifetime, 240 s idle, role change, shutdown) and `MAX_STREAMS_PER_INSTANCE=1`, `MAX_STREAMS_PER_PERSON=1`. Reached only through the admin app's `/live/stream` route, which signs the staff assertion and presents the app's Google identity; the public booking front door ([ADR-0023](0023-zero-cost-edge-front-door.md)) never reaches it. Role `clinic_realtime` with column-level SELECT on `appointment_events`, `appointments`, `patients`, `staff_action_audit`, `staff_invites` and `staff_access` (migration 0014, ADR-0015); problem+json errors whose `type` URIs point at the API's `/problems` catalogue.
- **Contract with FastAPI:** the `appointment_events` table schema plus a versioned JSON payload (`schema_version: 1`) defined in `contracts/events/appointment-event.v1.schema.json`. Go tests validate every marshalled event against it; the web validates incoming events with a zod schema tested against the same file's examples. Breaking changes mean `schema_version: 2` and a second event name, never an in-place change.
- **No RPC between the services.** FastAPI and the gateway never call each other; the database row is the interface. ADR-0007's rejection of gRPC/Connect therefore stands unchanged.
- **Fan-out:** each instance polls independently about once a second, only while it has subscribers. At max 2 instances that is at most 2 small indexed queries per second. The DB pool exists only while there are subscribers, so an idle instance holds no Neon connection.
- **Rejected:** option 1 for the concurrency-sharing reason above; option 3 because it adds a third-party account, keys and a data processor, costs money past its free tier, and still needs our own commit-safe cursor to publish from; option 4 because it pays the cost of a second deploy unit without the runtime advantage that justifies one.

## Consequences

- Good: booking is isolated from streaming; idle cost is zero (no subscribers, no queries, no instance).
- Good: the cursor logic is small, pure and unit-testable, and the out-of-order-commit case is tested against real Postgres (ADR-0018).
- Bad: a second language and deploy unit: a Go CI job, `govulncheck` and `gosec` (ADR-0017), its own image scan, `ship-realtime` (ADR-0016), and Go conventions
- Bad: per-instance polling scales linearly with instances, and stream caps are per instance.
- Bad ($0 audit): with one stream per instance and max 2 instances, at most 2 admin streams exist at once. The Go memory argument above (many idle streams per instance) is not used at this scale; we keep Go for the small image, fast start and standard-library SSE, and the concurrency can go back up if the CPU allowance stops being the binding limit.
- **What breaks at 10x and 100x.** At 10x (around 20 instances) the DB sees about 20 cursor queries per second and 20-40 held connections against Neon Free's limits, and Neon never suspends while anyone watches. At 100x the per-instance poll load and connection count dominate. The fix is a single relay: one poller publishing to Upstash Redis pub/sub (or Pub/Sub) and instances subscribing, keeping the same cursor as the event id.

## Assessment line

Section 1 "components, key decisions, trade-offs"; "REST API in FastAPI, DRF or Go" (Go used where its runtime model fits, FastAPI kept as the system of record).

## Review trigger

More than 5 gateway instances, more than 500 concurrent streams, a cursor query p95 above 50 ms, or Neon connection errors from the gateway: move fan-out to a single relay (Upstash Redis pub/sub or Pub/Sub). If the realtime gateway is dropped, or the admin feed is removed later, delete the service rather than keep a second runtime for nothing.
