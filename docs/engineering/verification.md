# Verification history

How each pull request was checked before it merged. Every figure on this page is quoted from the PR's own comments (the build session's local run and the red-team sign-off) or from its CI status. Where a comment does not give a number, the page does not either. "Head" is the commit the sign-off was written against; "merge" is the squash commit on `main`.

## How a change got to `main`

1. The build lane ran the full suite locally before every push (lint, hygiene, backend tests against a compose database, unit tests, both app builds, Playwright against the real API, cost checks, `ci-test`, `circleci config validate`, gitleaks, semgrep) and pasted the raw output into the PR.
2. A separate red-team review read the diff and ran its own checks against a real stack: real Postgres, real HTTP, a real browser. It either signed off or listed required changes.
3. The gatekeeper session, never the build lane, merged, only when CircleCI was green as a separate check and only into `main` (a stacked PR once merged into a feature branch, which is why the base branch is now checked first).

The same rules are in [ADR-0018](../adr/0018-testing-strategy.md) (no mocks of our own code) and the repository's PR template.

## Per pull request

Defects are counted as the red-team comment wrote them. "Rounds" is the number of review passes the comments show; PRs with a single sign-off had none visible beyond it.

| PR | Head | Merge | What the review found | What proved the fix |
|---|---|---|---|---|
| 19 two apps in a workspace | `d30a141` | `3205918` | Approved. Debt noted: `packages/ui` and `packages/api` need component tests | Prerendered HTML identical to main once asset hashes are stripped; `clinic-admin.ericgitangu.com` returned 200 for `/` and `/dashboard`; 13/13 CI green |
| 20 booking flow | `d9a7ed0` | `4b9bb2d` | Changes needed, 5 required items: a signed patient cookie with an ownership check, an e2e job against the real API, remove a section the API never fed, a reCAPTCHA verifier that fails closed, generic phone-exists wording. Two rounds | Lighthouse mobile `/book` 97/100/100/100; sign-off confirmed each item fixed; all checks green |
| 21 Vercel token error | `5c80788` | `b189944` | Approved | Green |
| 23 generated client | `bb62216` | `c4defb0` | Approved after required fixes under the no-mocks rule: delete the fake API from web-e2e, drop the fetch mock, make the drift check use `git status --porcelain`, make the snapshot stable. A double-booking e2e flake was root-caused (a wait that passed on the old URL) | The flake reproduced deterministically with the navigation slowed by 1.5 s, fixed, and then 20 serial repeats and 20 full runs at 2 workers passed. Runtime validation proven 5/5. Local run: backend pytest 118, Playwright 27/27, ci-test 55/55. CI 13/13 |
| 24 reviewer landing page | `aa08ce2` | `32abafd` | Approved, minors folded in | Lighthouse mobile 95/100/100/100; e2e 27/27 against the real compose API; the curl lines returned 201 then 409 `SLOT_TAKEN` |
| 25 admin dashboard | `2c726a7` | `b212f77` | Changes needed, 3 majors: `/internal/*` paths exposed in the public spec and `/docs`, the proxy forwarding `/internal/*` in several spellings, SAST failing on f-string SQL. Minors: append-only audit table, log the rejection reason | Public spec and `/docs` expose 0 `/internal` paths (with a test); proxy denylist covers plain, `%69`, `./`, `a/../`, uppercase and full-width spellings; semgrep 0 findings; every assertion attack returned 401 against the real stack; admin e2e 41, booking 27; CI 13/13 |
| 26 patient sign-in | `a6b6a44` | `9293f55` | Changes needed, 1 blocker: the account link used Better Auth's per-process user id, so two instances created two patients for one Google person. Minors: `email_verified`, 201 on create, short names | Reproduced first, then `two-instances.test.ts` runs the real OAuth callback on two instances and asserts one patient. Local: backend pytest 275 + 9 race and control, coverage 95.7%, admin Playwright 41/41, booking 28/28 three times |
| 27 emails and reminders (open) | `6ff0b14` | not merged | Changes needed, 4 majors: mail to unverified addresses, an e2e slot collision, no scheduled retry, a stale `/sent` suppressing a re-armed reminder | Fixes in one push; full suite 10 of 10 green at 2 workers and 10 of 10 at 1 worker; a first commit was refused by the commit hook and the comment says so |
| 28 missing sign-in settings | `b5a56ad` | `9755e94` | 2 red-team defects: a smoke that ignored `.env` files, a tautological matcher test | Mutation checks run: dropping `/auth/:path*` from booking's matcher fails a test; removing `favicon.ico\|robots.txt` from admin's exclusion fails two. Env check run against both Vercel projects: booking 11 names, admin 12. CI 12/12 |
| 30 admin icons and metrics cache | `c3adf73` | `c379e61` | Approved | Role check runs before the cache read; canonical-host 308 checked with a real `next start`; 65 unit tests and 56/56 admin e2e on a local merge with main; CI 13/13 |
| 31 idempotency, zones, slot function | `6f99f5c` | `81656f1` | Three gate rounds on isolated compose stacks | Round 4: backend 333 passed, coverage 95.09%; race 10 passed, control 1 passed; schemathesis 29 passed; booking Playwright 30 passed; mutations caught: a fresh key per call, the first clinic's zone for cancels (Los Angeles and Auckland), deleting `test_slots.py` against the 95% domain gate. CI 12/12 |
| 33 PWA and polling | `f9a86de` | `13f198a` | Three gate rounds. Two items carried forward to the realtime lane | Idle-stop e2e 20/20 under 4x CPU throttle and fails when the fix is reverted; polling scenarios at `--repeat-each=10` pass; the service worker caches only the static shell. CI 13/13 |
| 34 Vercel env check | `ebd1c7d` | `27d4a6b` | 6 gate findings: error path leaks, pagination, unset preconditions, exit code, malformed records, token scope (out of scope) | `test_ci_scripts.sh` 85/85; printing 200 bytes of an unreadable body fails exactly the two leak tests; live read-only run: booking 11 names, admin 12. CI 12/12 |
| 37 Go SSE gateway | `f341705` | closed | Closed without merge: superseded by the Ably decision. The comment records about 900 vCPU-seconds per connected hour against roughly 21,619 vCPU-seconds of shared free-tier headroom, and a limit of 2 concurrent streams | Not applicable |
| 39 outbox relay and Ably | `69edeb3` | `56d898a` | Three gate rounds. Accepted as minor: the relay's own call site is not pinned by a mutation (its outcome is the same because the debit refuses anyway); off Vercel a direct client can choose its `x-forwarded-for` bucket (a local-run caveat); the 200 token branch was verified with a test key, and live verification was to follow the first release | Mutations caught: seed, xmin guard, cap condition, `asyncio.wait_for`, `SKIP LOCKED`, and the relay call deleted per route (one route first passed, which exposed a gap the test then closed). Round 4 local run: backend 466 passed and 5 skipped, coverage 95.73%. Sign-off: `ably-real` 5 passed against the CI Ably app (job 2503); budget capped at 25,000 publishes a month, the service refuses to start above it; a hanging publisher leaves the booking under 2.5 s; no PII in events. CI 13/13 |
| 40 admin metrics flake | `9b531c2` | `9eb6ddb` | Approved; root cause: the refresh raced its own re-render | Repeated runs against a real stack green with no timeout changes and no retries; CI 13/13 |
| 41 inactive chips, double-booking guard | `0b844a8` | `a2d1117` | Two rounds: a wrong "just taken" notice removed (`pickWasTaken`) | Rebased on main, CI 12/12 including `e2e-real` |
| 32 production ZAP, Lighthouse, kill switch | `15b6d9c` | `57e0ec5` | Gated over three rounds. Declared and tracked: the Lighthouse `/` performance rule stays report-only until a hero change lands | The prune script resolves its keep set from the serving and previous revisions' digests, never deletes a tagged or traffic-bearing digest, and fails closed; fixture tests cover it. gitleaks pinned at 8.30.1 and sha256-verified; the secrets job scanned 99 commits with no leaks. CI 13/13, including admin-e2e |
| 36 self-hosted docs and fonts | `edc4081` | `ccaa2e2` | Approved. Disclosed: the self-only CSP on `/docs` blocks ReDoc's footer logo from `cdn.redoc.ly`; one CDN string remains in an unreachable better-auth server chunk (deduced) | Three mutations each fail `fonts.spec.ts` (dropping the ext unicode-range, dropping the ext face, un-claiming the tilde code points). Swagger and ReDoc render with every non-localhost request aborted, and the old `next/font/google` layout fails under the same block. Fonts add about 53 KB per app. CI 13/13 |
| 38 UI polish | `2206a2c` | `481b45e` | Approved after a conflict with 41 was resolved | Booking vitest and build pass; axe on `/` and `/book` shows no new serious or critical issues; reduced motion respected; LCP median 3.0 s to 1.9 s locally, verified earlier. CI 15/15 including `e2e-real` |
| 42 Lighthouse figures | `eb7543c` | `ba36259` | Approved: the `/` performance rule stays a warning because the sample from CI artifacts (job 2517) is below 0.85, so an error would not be truthful. The budget was not lowered. The pipeline-to-job label mapping is unchecked | CI green |
| 43 Lighthouse exit status | `94a50f4` | `0cc0608` | Root cause: earlier script tests exported `CIRCLE_BRANCH=feature`, so on the release pipeline, where the checkout is main, the Lighthouse cases got 0 instead of 3 (green on the PR, red on main) | `test_ci_scripts.sh` 165 passed, 0 failed with `origin/main` present; CI 13/13. A single-branch shallow clone fails safe and is a tracked follow-up |
| 45 admin-channel test | `39e2458` | `ab6383d` | Flake root cause: the test published before the stream opened and matched events on a channel shared with other pipelines | It now waits for the stream and matches a unique per-run probe id. `ably-real` passed in job 2769 (5 passed) and in 2753 and 2760 (3/3 at the head, including two pipelines 0.15 s apart). No timeout changes. No mutation was possible without a real key, so this is evidenced by CI history. CI 14/14 |
| 46 one Vercel token per project | `b376d29` | `7e4f588` | The CI token was scoped to `clinic-web` only (verified in the Vercel dashboard), which is why `ship-admin` failed | Admin ship, rollback and verify use `VERCEL_ADMIN_TOKEN`; booking keeps its own token and the script unsets the admin one in booking jobs; a missing token fails fast with nothing deployed. Fixture tests pass, CI 14/14. It takes effect when the token is added to the `vercel-prod` context |
| 47 fonts spec | `54cfbc0` | `994aad0` | Flake: the spec depended on how fast the font arrived | 10 local runs on a real build and under CPU load pass; every font file delayed by 1.5 s still passes; removing the latin-ext range fails it. No retries or timeouts added. CI 15/15 |
| 49 script-test ports | `d96ffaa` | `4aef3b8` | Fixed ports collided between runs; the collision was reproduced by occupying the old ports. Accepted: Lighthouse's free-port pick is bind then release, a narrow window | 25 runs of `test_ci_scripts.sh`, some under load and some as parallel pairs, 0 failures; no assertion weakened. CI 15/15 |

PRs 27 (emails), 44 (live availability in the booking app) and 48 (a double-submit e2e that must block the service worker) are open at the time of writing and have no sign-off to quote. PR 29 (ADR corrections) and PR 35 (this documentation) are open too, and PR 22 (the AI reflection) has no review comment.

## Proofs that a test can fail

A test that has never been seen failing proves little, so these are the mutation checks the comments record, each run and then restored:

- PR 28: dropping a path from a route matcher, and un-excluding a file, each fail a named test.
- PR 31: using a fresh idempotency key per call fails the double-submit e2e; using the first clinic's zone fails the cancel-zone tests; removing `test_slots.py` fails the 95% domain coverage gate, and a crafted 94.5 to 95 value fails it too (hence two-decimal precision).
- PR 33: reverting the idle-stop fix fails its e2e.
- PR 34: echoing part of an unreadable response body fails the leak tests.
- PR 39: seven mutations in the relay and budget code each fail a named test; one route (`reschedule_appointment`) passed the first mutation, which exposed a gap the test then closed.
- The race suite itself carries its own control: the same barrier against a database without the index must book more than once ([ADR-0018](../adr/0018-testing-strategy.md)).

## Live production checks

- PR 19: the admin host returned 200 for `/` and `/dashboard` before merge.
- PR 34 and PR 28: the environment check ran read-only against the real Vercel projects and reported 11 required names for booking and 12 for admin, without printing values.
- PR 28 sign-off: `ship-api` sets `INTERNAL_SIGNING_KEY` from Secret Manager, which matched the live API revision.
- The release pipeline runs `scripts/verify_claims.py` against each new tagged revision before it gets traffic, and `verify-release` checks the public URL afterwards ([ADR-0016](../adr/0016-cicd-circleci-keyless-deploy.md)).

### Release of 2026-10-18, observed by the gatekeeper after the pipeline for PR 43 (commit `0cc0608`)

- `ship-api`: `clinic-api` revision `00067-yaj` serves `sha-0cc0608` at 100%, with `ABLY_API_KEY` from Secret Manager in its environment.
- The first real image prune kept exactly the serving image (`sha-0cc0608`) and the rollback image (`sha-a2d1117`) and removed the superseded `9eb6ddb` image.
- `ship-booking` succeeded. `ship-admin` failed because the `vercel-prod` token is scoped to `clinic-web`; PR 46 fixes it with a per-project token, and the admin release path passes only after `VERCEL_ADMIN_TOKEN` is added to the `vercel-prod` context. Until then `verify-release`, `smoke-public` and `zap-prod` have not run on a release.
- Live API at 11:34 UTC through `clinic.ericgitangu.com/api`: `POST /patients` created a labelled test patient; `POST /appointments` with an `Idempotency-Key` for Dr. Brian Kamau at 2026-10-20 09:00+03:00 returned 201; the same request with the same key returned 201 with `Idempotent-Replayed: true` and the same appointment id; the slot then disappeared from availability; `PATCH .../cancel` returned 200.
- Ably production app `clinical-booking-prod`: the 24 hour message count went from 17 to 21. That matches the design: a `slot_taken` plus an admin event on the booking, and a `slot_freed` plus an admin event on the cancel. The test patient remains, named "Release Gate Check (test, cancelled)", with a cancelled appointment.

## Known limits of the test setup

- The double-booking specs and the fixed-slot `booking.spec` test fail on a reused database, also on `main`. End-to-end runs assume a fresh database per run: CI provides one, and `make e2e` recreates the compose volume itself (Makefile, `e2e` target). Only a direct Playwright run on a kept stack (`pnpm -C apps/booking test:e2e`, or `KEEP_STACK=1 make e2e-admin`, per `scripts/e2e_admin.sh`) needs `make down` first, which runs `docker compose down -v`. PR 48 (open) removes a related service-worker routing dependency in the double-submit test.
- The development-environment isolation follow-up (per-run port and database isolation, `reuseExistingServer` false, a configurable API host port, `coverage.xml` in `.gitignore`) is descoped for time. Risk: parallel local runs can collide. Fix: that follow-up.
- The Lighthouse `/` performance rule is a warning, not an error: CI medians varied from 77 to 89 run to run (PR 42), and the 0.85 budget has not been lowered.
- `test_ably_real.py` needs the CI Ably key, so it is skipped locally and runs only in CI.

- Resend Domains page, observed by the gatekeeper on 2026-10-18: `mail.ericgitangu.com` is the only domain with status Verified. The booking emails in PR 27 (open) are sent from it, per the ADR-0025 amendment in that PR.
