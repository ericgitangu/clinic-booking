# ADR-0001: Monorepo layout and task runner

- Date: 2026-10-16
- Deciders: engineering
- Plan reference: [PLAN.md §7](../architecture/PLAN.md#7-repository-layout--conventions)
- Amended: 2026-10-16, `services/realtime` Go module and `contracts/events/` for stretch S1

## Status
Accepted

## Context
The repository holds a Python API, an optional Next.js app, IaC and CI config. We looked at moon, a Makefile, and uv/pnpm/go workspaces. Every tool a reviewer has to learn before they can run the tests is a cost to them.

## Considered options
1. moon task graph over uv + pnpm workspaces.
2. A root Makefile as the single entry point, a uv project in `backend/`, and a pnpm workspace at the root that contains only `web/`. The root `package.json` holds husky, lint-staged and commitlint.
3. Turborepo or Nx.

## Decision
Option 2.
- **Top-level directories:** `backend/`, `web/`, `infra/`, `docs/`, `scripts/`, `contracts/`, `.circleci/`.
- **Entry points:** `make help` lists every target. CI calls the same Make targets wherever practical.
- **Stretch S1:** `services/realtime/` is a single Go module with its own `go.mod`. With one module there is no `go.work`; the Makefile adds `rt-*` targets that `cd` into it. `contracts/events/` holds the versioned JSON Schema shared by FastAPI, the gateway and the web. The Go module imports nothing from the other packages, so there is still no cross-package build graph. If S1 is cut before WP-S1a merges, neither directory exists; if it is cut after, only `contracts/events/` remains (PLAN.md TD24).

## Consequences
- Good: one entry point that every reviewer already understands.
- Good: no extra tool to install.
- Bad: no task-graph caching. With two packages that doesn't matter.
- Bad: Node is needed at the root for husky. The web app and the codegen drift check need Node anyway.
- Bad (if S1 ships): a reviewer who wants to run the realtime tests also needs a Go toolchain. `make up` and `make test` do not require it.

## Assessment line
"Sensible structure (not one file)"; "A well-reasoned README alongside functional code".

## Review trigger
Four or more deployables with a cross-package build graph. At that point, adopt moon. With S1 we reach four deployables (API, migrate job, web, realtime) but still no cross-package build graph, so the trigger has not fired; a second Go module or shared generated code across Go and TS would fire it.
