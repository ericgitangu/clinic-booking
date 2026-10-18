# ADR-0007: API style is REST + OpenAPI 3.1 (tRPC, GraphQL, gRPC verdict)

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted

**Build status (2026-10-18, main 748d7d8): Shipped.** FastAPI serves REST with OpenAPI 3.1 and the docs routes are public through the front door. No tRPC, GraphQL or gRPC was introduced. The Go gateway paragraph below applies again: the gateway is built (ADR-0021, PR 71) and still adds no gRPC.

## Context

We looked at tRPC, gRPC, GraphQL, ConnectRPC and REST over HTTP/2, and whether TanStack Query can be combined with tRPC and gRPC. The brief lists REST verbs and paths and asks for HTTP status codes.

## Considered options

1. tRPC.
2. GraphQL.
3. Native gRPC.
4. ConnectRPC.
5. End-to-end h2c.
6. REST + OpenAPI 3.1 from FastAPI, served over HTTP/2 at the edge.

## Decision

Option 6. `/docs`, `/redoc` and `/openapi.json` are public in production.

| Option | Verdict | Reason |
|---|---|---|
| tRPC | Reject | No IDL: types are inferred from a TypeScript `AppRouter`, so the server must be TypeScript. With FastAPI it would only work through a redundant TS BFF and a second contract |
| GraphQL | Reject | Returns 200 with an `errors` array, which works against "correct HTTP status codes". Adds a DataLoader/N+1 surface for four entities |
| Native gRPC | Reject | Browsers cannot speak it. Cloud Run would need `--use-http2` and an h2c server |
| ConnectRPC | Reject | Pre-1.0 Python implementation. The brief says REST |
| End-to-end h2c | Reject | Cloud Run's front end already serves h2 to clients. Uvicorn speaks HTTP/1.1 behind it |
| REST over h2 at the edge | Accept | The default on Cloud Run and Vercel, at no cost |

**Can tRPC, gRPC and TanStack be used together?** Yes, in a TypeScript-everywhere stack. TanStack Query has adapters for both (`@trpc/tanstack-react-query`, `@connectrpc/connect-query`) and doesn't care about transport. With a Python backend, the cross-language equivalent of tRPC's end-to-end types is pydantic → OpenAPI → generated TS/zod/TanStack hooks (ADR-0011).

**The stretch Go gateway (ADR-0021) does not change this verdict.** FastAPI and the gateway never call each other; their interface is the `appointment_events` table plus a versioned JSON event schema. With no network hop between the services, gRPC/Connect would add an IDL and a toolchain for nothing. The browser-facing stream is plain SSE over HTTP.

## Consequences

- Good: the contract is the standard reviewers expect, and Swagger works out of the box.
- Bad: type safety comes from codegen and a drift gate, not from inference.

## Assessment line

The Section 2 endpoint list; "correct HTTP status codes".

## Review trigger

Three or more heterogeneous clients needing different projections means GraphQL. Service-to-service streaming means Connect.
