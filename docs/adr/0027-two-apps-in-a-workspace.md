# ADR-0027: Two web apps in one workspace: booking and admin

- Date: 2026-10-17
- Deciders: engineering, decided by the engineer
- Amends: [ADR-0010](0010-thin-nextjs-booking-ui.md), [ADR-0023](0023-zero-cost-edge-front-door.md), [ADR-0024](0024-google-sign-in-with-better-auth.md)

## Status

Accepted. The patient app and the admin dashboard are two separate Next.js 16 apps in one pnpm workspace, deployed as two Vercel projects, sharing code through two internal packages.

**Build status (2026-10-18, main 748d7d8): Shipped.** Two Next.js apps share `packages/ui` and `packages/api`, ship as two Vercel projects, and have separate service accounts, CI ship jobs and rollbacks. Admin sign-in is open and the role gates access (ADR-0030). The Vercel project settings live outside the repository.

## Context

- ADR-0010 put the dashboard inside the one web app under `/admin`. That makes the patient bundle carry admin code, puts both audiences behind one sign-in surface and one deployment, and makes every admin change redeploy the patient site.
- The admin area has a different audience (one person), different risk (it reads aggregates for the whole clinic) and a different cadence. The engineer wants them separated.
- Everything must stay at $0 and keep the existing guards: IAM-gated Cloud Run, the Vercel identity, the rollback.

## Considered options

1. One app with route groups (`/admin` inside the patient app). The status quo. Cheapest, but one bundle, one auth surface, one deploy.
2. Two apps in a pnpm workspace with shared packages and two Vercel projects. More moving parts, clean separation.
3. Two repositories. The shared UI and the API client would have to be published or copied. Rejected: too much ceremony for one person.

## Decision

Option 2.

### Layout

```text
apps/booking      the patient app (today's web/, moved)
apps/admin        the dashboard (new, built in the dashboard slice)
packages/ui       shadcn primitives, the Idyllic theme, haptics, notify, SiteFooter, ...
packages/api      generated zod client, the server-side call helper, the proxy core
pnpm-workspace.yaml   packages: apps/*, packages/*
```

### What moves where

| Today (`web/`) | After |
|---|---|
| `src/app/api/[...path]/route.ts` (the public proxy route), `src/app/docs`, `src/app/redoc`, `src/app/openapi.json`, pages, icons, manifest, sitemap, robots | `apps/booking/src/app/...`. The booking app keeps the IAM proxy, `/docs`, `/redoc` and `/openapi.json`, and nothing else gets them |
| `src/lib/proxy/{forward,gcp-id-token,rate-limit,log}.ts` | `packages/api` (the logic); the route file that wires them stays in `apps/booking` |
| `src/generated/openapi.public.json`, `scripts/snapshot-openapi.mjs` | `apps/booking` (the static `/openapi.json` is a booking concern); the zod schemas generated from `contracts/openapi.json` go to `packages/api` |
| `src/components/ui/*` (generated shadcn), the theme tokens in `globals.css`, `lib/utils.ts` | `packages/ui` |
| `src/lib/haptics.ts`, `src/lib/notify.ts`, `components/layout/*` (shell, header, footer, theme provider and toggle, lazy toaster), `components/brand/lotus-mark.tsx`, `public/brand/*` | `packages/ui` (the header takes its navigation links as a prop) |
| `src/lib/site.ts`, `src/lib/metadata.ts`, `vercel.json`, `next.config.ts`, `tests/`, `e2e/`, `playwright.config.ts` | each app owns its own copy (different name, host, icons, nav) |

### What the shared packages export

- `@clinic/ui`: every shadcn primitive, `cn`, `PageShell`, `SiteHeader`, `SiteFooter` and `RECAPTCHA_ATTRIBUTION`, `ThemeProvider`, `ThemeToggle`, `LotusMark`, `LazyToaster`, `vibrate` and `PATTERNS`, `notify`, and a `theme.css` with the tokens that each app imports from its own `globals.css`. Apps list it in `transpilePackages`.
- `@clinic/api`: the zod schemas generated from the OpenAPI contract and the `ProblemCode` type, `callApi` (the server-side call: Cloud Run ID token plus the signed assertion of [ADR-0024](0024-google-sign-in-with-better-auth.md)), and the proxy core (`forward`, `mintIdToken`, `rateLimit`, `logRequest`). `callApi` and the schemas are used by both apps; the proxy core only by booking.
- Packages are internal (`private`, never published), have unique names, and each app depends on them explicitly so Vercel's affected-project detection and `pnpm --filter` work.

### Vercel

- Two projects on the Hobby plan, which allows 200 projects per account and 50 domains per project (<https://vercel.com/docs/limits>, read 2026-10-17): `clinic-web` becomes the booking app (Root Directory `apps/booking`) and a new `clinic-admin` takes `apps/admin`. Each project includes source files outside its Root Directory, because the workspace packages live there (<https://vercel.com/docs/monorepos>).
- CI keeps the token-free offline build and the prebuilt deploy, now run per app from the repo root with `rootDirectory` set to that app.

### Identity and sign-in

- The Vercel identity provider admits two subjects, `clinic-web` and `clinic-admin` production. Each project maps to its own service account (`clinic-web` as today, a new `clinic-admin`), each holding `roles/run.invoker` on `clinic-api` and nothing else. The reCAPTCHA service account stays reachable only from booking. The live invoker check now expects exactly `clinic-web`, `clinic-admin` and `clinic-smoke`.
- Each app runs its own Better Auth instance with its own secret and its own host-only cookie, so a patient session is never an admin session. The admin app refuses every sign-in that is not the allowlisted verified email at the moment of sign-in, not only on its pages. The booking app has no admin role.

### CI and rollback

- Two build jobs and two ship jobs (`ship-booking`, `ship-admin`) in the same serial group as the API. Both use the `vercel-prod` context, whose team-scoped token can deploy either project; the admin jobs override `VERCEL_PROJECT_ID` with the admin project's id (not a secret) so no second token is stored.
- `verify-release` checks both public hosts, and the rollback covers both: each ship job records the deployment that was live, and the `rollback-booking` and `rollback-admin` jobs (both the `rollback-app` job) restore each app by id. The API rollback is unchanged and still runs first.

## Consequences

- Good: the patient bundle carries no admin code; the admin has its own auth surface, deploy and rollback; an admin change never redeploys the patient site.
- Good: still $0: Hobby covers the projects and domains.
- Bad: more moving parts: two projects, two contexts, two ship jobs, a second service account and WIF subject, two Better Auth configurations.
- Bad: shared packages need care (transpiling, one lockfile, unique names) and a monorepo build can fail in ways a single app cannot.
- Bad: the dashboard slice now creates an app rather than a folder, so it carries the second project's setup.

## Assessment line

Section 1 "components, key decisions, trade-offs": two audiences, two apps.

## Implementation note

Landed as written, with two differences. `@clinic/api` holds only the proxy core so far: the generated zod schemas and `callApi` arrive with the first slice that needs them. The patient app's Vercel Root Directory moves from `web` to `apps/booking` when this change merges, because the project setting is not in the repository.

**Amendment (2026-10-18): what `@clinic/api` holds and who may sign in to admin.**

- `@clinic/api` holds more than the proxy core. Besides `forward`, `mintIdToken`, `rateLimit` and `logRequest` (`src/proxy/`), it holds `callApi` (`src/call.ts`), the signed assertion (`src/assertion.ts`), the reCAPTCHA check (`src/recaptcha.ts`) and the client generated from the contract (`src/generated/`: types, zod schemas and the SDK, [ADR-0011](0011-openapi-codegen-contract.md)). The Implementation note above, which says it holds only the proxy core, describes the first commit.
- The "Identity and sign-in" bullet says the admin app refuses every sign-in that is not the allowlisted verified email. As built, admin sign-in is open to any Google account with a verified email, and the role decides access: the owner comes from `ADMIN_EMAILS`, everyone else needs an active `staff_access` row, and a signed-in person with no role sees the forbidden page ([ADR-0030](0030-staff-roles-and-access.md)). The separate Better Auth instance, secret and host-only cookie per app are as decided.

## Review trigger

A third audience (staff, doctors) or a Hobby plan limit. Either may argue for one admin app with roles, or for a paid plan.
