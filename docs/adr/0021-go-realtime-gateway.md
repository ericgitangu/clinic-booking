# ADR-0021: A Go SSE gateway for the admin realtime feed (realtime gateway)

- Date: 2026-10-16
- Deciders: engineering

## Status

**Amended 2026-10-17: optional, and built only after the admin dashboard ([ADR-0010](0010-thin-nextjs-booking-ui.md)). The dashboard starts with server revalidation.**

Accepted (gated realtime gateway; built only after Gate B, cut last of the stretch items). It amends ADR-0002 (Go is now allowed for one read-only job, never in the write path) and implements the admin half of ADR-0009.

**Build status (2026-10-18, main 4aef3b8): Superseded by ADR-0031; never built.** The Go service, its role, CI lane, ship job and event contract do not exist and will not be built. The admin dashboard uses server revalidation.

**Superseded (2026-10-18) by [ADR-0031](0031-realtime-push-via-ably-sse.md).** The engineer decided to use Ably over SSE for patients and admins instead of a Go gateway on Cloud Run. This ADR is not built and will not be built; the text below stays as the record of what was considered.

## Context

- **The job.** Hold many long-lived, mostly idle HTTP connections and push a few small events to them. Read one table. Never write, never decide availability.
- **The platform.** Cloud Run, scale-to-zero, request-based billing (an open stream bills its instance for as long as it is open; ADR-0014 has the arithmetic), a 300 s request timeout we choose to set, Neon Free. LISTEN/NOTIFY is rejected on its merits in ADR-0009 (lossy, needs a change in the booking transaction, a global commit lock, a session held even with no clients), not only because Neon's pooled endpoint lacks it.
- **What the stream must guarantee.** No skipped and no duplicated events across reconnects, even when transactions commit out of order (ADR-0009's xid8 snapshot-horizon cursor).
- **What it must not do.** Starve `POST /appointments` of concurrency, keep Neon awake when nobody is watching, or expose PII.
- **The cost of a second language.** A second toolchain, image, CI lane (tests, govulncheck, gosec, trivy), deploy job and set of conventions. ADR-0002 rejected Go for exactly that reason when nothing required it.

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
- **Shape:** `GET /stream` and `GET /health`; min 0 / max 2 instances, `--concurrency 1 --cpu 0.25` (amended by the $0 audit: at 1 vCPU a dashboard held 8 h a day for a week passes the monthly CPU allowance on its own; at 0.25 vCPU it uses about 28%; the hosting lock review bounds the adversarial case server-side with a monthly stream budget, at most 86,400 vCPU-s; [ADR-0014](0014-hosting-region-and-cost.md) has the arithmetic, and `MAX_STREAMS_PER_INSTANCE` becomes 1), 256 MiB, timeout 300 s, region us-east4, reached only through the front door ([ADR-0023](0023-zero-cost-edge-front-door.md)); role `clinic_realtime` with column-level SELECT on `appointment_events` only (ADR-0015); problem+json errors whose `type` URIs point at the API's `/problems` catalogue.
- **Contract with FastAPI:** the `appointment_events` table schema plus a versioned JSON payload (`schema_version: 1`) defined in `contracts/events/appointment-event.v1.schema.json`. Go tests validate every marshalled event against it; the web validates incoming events with a zod schema tested against the same file's examples. Breaking changes mean `schema_version: 2` and a second event name, never an in-place change.
- **No RPC between the services.** FastAPI and the gateway never call each other; the database row is the interface. ADR-0007's rejection of gRPC/Connect therefore stands unchanged.
- **Fan-out:** each instance polls independently about once a second, only while it has subscribers. At max 2 instances that is at most 2 small indexed queries per second. The DB pool exists only while there are subscribers, so an idle instance holds no Neon connection.
- **Rejected:** option 1 for the concurrency-sharing reason above; option 3 because it adds a third-party account, keys and a data processor, costs money past its free tier, and still needs our own commit-safe cursor to publish from; option 4 because it pays the cost of a second deploy unit without the runtime advantage that justifies one.

## Consequences

- Good: booking is isolated from streaming; idle cost is zero (no subscribers, no queries, no instance).
- Good: the cursor logic is small, pure and unit-testable, and the out-of-order-commit case is tested against real Postgres (ADR-0018).
- Bad: a second language and deploy unit: a Go CI lane, `govulncheck` and `gosec` (ADR-0017), its own image scan, `ship-realtime` (ADR-0016), and Go conventions
- Bad: per-instance polling scales linearly with instances, and stream caps are per instance.
- Bad ($0 audit): with one stream per instance and max 2 instances, at most 2 admin streams exist at once. The Go memory argument above (many idle streams per instance) is not used at this scale; we keep Go for the small image, fast start and standard-library SSE, and the concurrency can go back up if the CPU allowance stops being the binding limit.
- **What breaks at 10x and 100x.** At 10x (around 20 instances) the DB sees about 20 cursor queries per second and 20-40 held connections against Neon Free's limits, and Neon never suspends while anyone watches. At 100x the per-instance poll load and connection count dominate. The fix is a single relay: one poller publishing to Upstash Redis pub/sub (or Pub/Sub) and instances subscribing, keeping the same cursor as the event id.

## Assessment line

Section 1 "components, key decisions, trade-offs"; "REST API in FastAPI, DRF or Go" (Go used where its runtime model fits, FastAPI kept as the system of record).

## Review trigger

More than 5 gateway instances, more than 500 concurrent streams, a cursor query p95 above 50 ms, or Neon connection errors from the gateway: move fan-out to a single relay (Upstash Redis pub/sub or Pub/Sub). If the realtime gateway is dropped, or the admin feed is removed later, delete the service rather than keep a second runtime for nothing.
