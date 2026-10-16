# ADR-0011: Schema reconciliation: pydantic → OpenAPI → TS/zod/TanStack

- Date: 2026-10-16
- Deciders: engineering

## Status
Accepted (built with the UI)

## Context
We want end-to-end types between a Python backend and a TypeScript frontend without writing the schema twice. zod and pydantic must never drift apart.

## Considered options
1. Hand-written zod schemas that mirror pydantic.
2. `@hey-api/openapi-ts` 0.99.0, exact pin.
3. orval.

## Decision
Option 2.
- **Export:** `backend/scripts/export_openapi.py` writes `app.openapi` to `contracts/openapi.json` with sorted keys. It uses a fixed `Settings` object so the output never depends on the environment.
- **Codegen config:** `web/openapi-ts.config.ts` uses plugins `@hey-api/client-fetch`, `@hey-api/sdk` (validator on), `zod` and `@tanstack/react-query`.
- **Packages:** the fetch client is **bundled** in openapi-ts since 0.73.0. The standalone `@hey-api/client-fetch` package is deprecated (npm notice observed 2026-10-16) and is not installed.
- **Committed output:** the generated code is committed and marked `linguist-generated`.
- **Drift gate:** CI job `contract-drift` runs `make openapi && pnpm -C web gen:api && git diff --exit-code contracts web/src/api/generated`.
- **Hand-written zod** is allowed only for form-only fields, with one stretch exception: the SSE event v1 schema (`web/src/lib/event-schema.ts`, stretch S1). The event is not part of the OpenAPI document; its source of truth is `contracts/events/appointment-event.v1.schema.json`, and a vitest validates every `examples` entry of that file with the zod schema.

## Consequences
- Good: a pydantic change that isn't regenerated fails CI.
- Bad: hey-api is 0.x, so it is pinned exactly and never bumped during the assessment window.

## Assessment line
"Sensible structure". The frontend/backend split is enforced mechanically.

## Review trigger
hey-api 1.0, or a breaking minor release. At that point, re-evaluate against orval.
