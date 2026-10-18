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
| 39 outbox relay and Ably (open) | `09df9d9` | not merged | Round 2 to round 4 comments | Mutations caught (seed, xmin guard, cap condition, `asyncio.wait_for`, `SKIP LOCKED`, the relay call per route). Round 4: backend 466 passed and 5 skipped, coverage 95.73%; the real-Ably test `ably-real` passed in CI job 2248 (`5 passed`), after a first live run that failed 2 of 5. One CI step (`gitleaks`, a tool download) failed and needed a rerun |
| 40 admin metrics flake | `9b531c2` | `9eb6ddb` | Approved; root cause: the refresh raced its own re-render | Repeated runs against a real stack green with no timeout changes and no retries; CI 13/13 |
| 41 inactive chips, double-booking guard | `0b844a8` | `a2d1117` | Two rounds: a wrong "just taken" notice removed (`pickWasTaken`) | Rebased on main, CI 12/12 including `e2e-real` |

PRs 29 (ADR corrections), 32 (production ZAP, Lighthouse, kill switch), 35 (README), 36 (self-hosted docs and fonts) and 38 (UI polish) are open at the time of writing, and PR 22 (the AI reflection) has no review comment. They are not summarised above because they have no sign-off to quote yet.

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
