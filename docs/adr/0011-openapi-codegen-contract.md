# ADR-0011: Schema reconciliation: pydantic → OpenAPI → TS/zod/TanStack

- Date: 2026-10-16
- Deciders: engineering

## Status

Accepted (built with the UI)

**Build status (audit 2026-10-17): Built, text stale.** The contract is exported to `contracts/openapi.json` and generated into `packages/api` with hey-api 0.99.0 as types, zod and an SDK, with a CI freshness check. Not generated: TanStack Query hooks and the SSE event schema. The `.gitattributes` generated path in the body is out of date.

## Context

We want end-to-end types between a Python backend and a TypeScript frontend without writing the schema twice. zod and pydantic must never drift apart.

## Considered options

1. Hand-written zod schemas that mirror pydantic.
2. `@hey-api/openapi-ts` 0.99.0, exact pin.
3. orval.

## Decision

Option 2.

- **Export:** `backend/scripts/export_openapi.py` writes `app.openapi` to `contracts/openapi.json` with sorted keys. It uses a fixed `Settings` object so the output never depends on the environment.
- **Codegen config:** `packages/api/openapi-ts.config.ts` (output `packages/api/src/generated`) uses plugins `@hey-api/client-fetch`, `@hey-api/sdk` (validator on), `zod` and `@tanstack/react-query`.
- **Packages:** the fetch client is **bundled** in openapi-ts since 0.73.0. The standalone `@hey-api/client-fetch` package is deprecated (npm notice observed 2026-10-16) and is not installed.
- **Committed output:** the generated code is committed (`packages/api/src/generated`, plus the public spec snapshot `apps/booking/src/generated/openapi.public.json`) and marked `linguist-generated` in `.gitattributes`.
- **Drift gate:** CI runs it in two places: `backend-quality` runs `make openapi` and `git diff --exit-code contracts/openapi.json`, and `lint` runs `make gen-client` and fails if `git status --porcelain packages/api/src/generated apps/booking/src/generated` shows any change (untracked files count).
- **Hand-written zod** is allowed only for form-only fields, with one stretch exception: the SSE event v1 schema (`web/src/lib/event-schema.ts`, stretch S1). The event is not part of the OpenAPI document; its source of truth is `contracts/events/appointment-event.v1.schema.json`, and a vitest validates every `examples` entry of that file with the zod schema.

**Amendment (2026-10-18): what is configured today.** `packages/api/openapi-ts.config.ts` enables `@hey-api/typescript`, `zod` (with `dates: { offset: true }`, because the API sends `+03:00` offsets), `@hey-api/client-fetch` and `@hey-api/sdk` (validator on). The `@tanstack/react-query` plugin listed above is **not configured yet**; adding it is planned and in progress in a separate change, and this ADR does not claim it has landed. The SSE event schema and `contracts/events/` belong to stretch S1, which is not built. One known path mismatch outside the docs: `.gitattributes` still marks `apps/booking/src/api/generated/**` as generated, while the generated code lives in `packages/api/src/generated`; that file is not covered by this change.

## Consequences

- Good: a pydantic change that isn't regenerated fails CI.
- Bad: hey-api is 0.x, so it is pinned exactly and never bumped during the assessment window.

## Assessment line

"Sensible structure". The frontend/backend split is enforced mechanically.

## Review trigger

hey-api 1.0, or a breaking minor release. At that point, re-evaluate against orval.
