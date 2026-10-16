# ADR-0002: FastAPI as the single system of record (no Go service in the write path)

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, a read-only Go SSE gateway is allowed as gated stretch S1 (ADR-0021)

## Status

Accepted

## Context

The brief allows FastAPI, DRF or Go. Most of the evaluation weight is on reasoning and tests. We considered a polyglot backend, adding a Go service, but a second runtime doubles CI, Docker, SAST (gosec, govulncheck) and the deploy surface. Splitting availability out from booking would also put the uniqueness invariant on the far side of a network boundary.

## Considered options

1. A single FastAPI service.
2. A single DRF service.
3. FastAPI plus a Go service: either a Go availability service, or a Go realtime gateway built now.

## Decision

Option 1.

- **Layering:**
  - `api/` routers parse and serialize only.
  - `services/` own transactions.
  - `domain/` is pure, with no I/O.
  - `repositories/` hold SQL and the constraint/SQLSTATE mapping.
  - `db/` and `core/` hold the remaining plumbing.
- **Paths:** the brief's exact paths at the root, with no `/v1`.
- **Go:** never in the write path and never a system of record. The only Go code allowed is the read-only SSE gateway of stretch S1 (ADR-0021), which reads `appointment_events` and cannot change state. No `.proto` file is committed. If S1 does not ship, there is no Go in the repository.

## Consequences

- Good: one runtime and one image, so one place for the invariant to live.
- Bad: Python cold start is slower than Go's. We mitigate it with `--cpu-boost`, lazy engine creation, lean imports and a single uvicorn worker.
- Bad: with no `/v1` prefix, a breaking change later means introducing `/v2`.
- If S1 ships, we accept the second runtime's cost named in Context (CI, Docker, gosec, govulncheck, deploy surface) for that one job only; the uniqueness invariant stays in one place because the gateway never writes.

## Assessment line

"REST API in FastAPI, DRF or Go"; "sensible structure"; and our own rule that every extra must be justified against the brief.

## Review trigger

A measured p99 the Python service cannot meet, a bounded context with different scaling needs, or the realtime threshold in ADR-0009.
