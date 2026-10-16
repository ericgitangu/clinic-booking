# ADR-0016: CI/CD on CircleCI with keyless deploy to Cloud Run

- Date: 2026-10-16
- Deciders: engineering
- Amended: 2026-10-16, Go jobs, `ship-realtime` and the SSE smoke for stretch S1
- Amended: 2026-10-16, $0 cost audit: IAM-gated services behind the Vercel front door ([ADR-0023](0023-zero-cost-edge-front-door.md)), region us-east4, a credit budget, self-skipping lanes and the `cost-static` / `cost-check` jobs

## Status

Accepted

## Context

- **Why not GitHub Actions.** It is unavailable to us this month because of a billing issue. The repository stays on GitHub.
- **CircleCI constraints:**
  - GitHub App trigger presets cannot be combined in one trigger.
  - Fork PRs never trigger pipelines.
  - Job-level branch filters are deprecated.
  - `.circleci/config.yml` can be edited by anyone who can push a branch, so any `when:` gating in it protects nothing on its own.
- **GCP constraints:**
  - WIF `google.subject` is limited to 127 bytes (from `gcloud iam workload-identity-pools providers create-oidc --help`).
  - With `allowed_audiences` empty, the token `aud` must equal the provider's resource name. CircleCI tokens carry `aud = <org id>`.
  - `roles/run.developer` lacks `run.services.setIamPolicy`.

## Considered options

1. CircleCI, two workflows gated on branch, keyless OIDC → WIF.
2. Cloud Build triggers, which would be a second CI system.
3. CircleCI with a long-lived service-account JSON key.

## Decision

Option 1.

**Workflows.**

- **Trigger:** the GitHub App preset "PR opened or pushed to, default branch and tag pushes".
- **`pr`:** runs when the branch is not `main` and the pipeline is not a tag.
- **`release`:** runs when the branch is `main` and the pipeline is not a tag. It runs the same verify jobs, then `build-scan-push → ship-api → ship-web`. `ship-web` is lean core: it deploys the `web` project, whose route handlers are the front door.
- **Added by the zero-cost audit:** `release` also runs `cost-check` (after `ship-api`, context `gcp-deploy`, read-only gcloud calls). (`ship-frontdoor` is superseded by the engineer's one-project decision: the proxy deploys with `ship-web`.) `pr` and `release` both run `cost-static` (no credentials). **Added by the hosting lock review:** `release` runs `smoke-public` after `ship-web`, with no context and no credentials, against the public URL (`verify_claims.py --base-url "$PUBLIC_API"`, the docs check, the `servers` check, run.app → 403); it is lean core and never cut. `ship-web` and `smoke-public` halt when `ship-api` skipped promotion.

**Keyless auth, done by hand rather than with an orb.**

```bash
echo "$CIRCLE_OIDC_TOKEN_V2" > /tmp/oidc.jwt
gcloud iam workload-identity-pools create-cred-config \
  "projects/${GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/circleci/providers/circleci-oidc" \
  --service-account="${DEPLOYER_SA}" --credential-source-file=/tmp/oidc.jwt --output-file=/tmp/gcp-cred.json
gcloud auth login --cred-file=/tmp/gcp-cred.json
gcloud config set project "${GOOGLE_PROJECT_ID}"
```

**WIF provider.**

- **Issuer:** `https://oidc.circleci.com/org/<ORG_ID>`, with `allowed_audiences = [<ORG_ID>]`.
- **Subject mapping:** `google.subject = assertion['oidc.circleci.com/project-id'] + ':' + assertion['oidc.circleci.com/vcs-ref']`, about 52 bytes. **Never `assertion.sub`**, which is 160 bytes or more.
- **Attribute:** `attribute.project_id = assertion['oidc.circleci.com/project-id']`.
- **Condition:** `assertion['oidc.circleci.com/project-id'] == '<PROJECT_ID>' && assertion['oidc.circleci.com/vcs-ref'] == 'refs/heads/main'`.
- **Fallback if the `vcs-ref` claim is absent:** subject = project-id only, and condition `assertion.sub.endsWith('/vcs-ref/refs/heads/main')`.
- **Binding:** the deployer SA gets `roles/iam.workloadIdentityUser` for `principalSet://.../attribute.project_id/<PROJECT_ID>`.

**Contexts.**

- `gcp-deploy` (identifiers only) and `vercel-prod` (`VERCEL_TOKEN`, plus the identifiers `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` since the hosting lock review, so `vercel pull` uses the engineer-created project `clinic-web` and never links or creates one) carry an expression restriction `pipeline.git.branch == "main"`. That is a second layer beside the WIF condition, because the config file itself is editable by anyone who can push.
- `oidc-probe` is empty and unrestricted. It exists only for the WIF-deny test.

**Bootstrap, once, by the engineer.** `infra/bootstrap.sh` creates `clinic-api` from the public hello image with `--no-allow-unauthenticated`, then binds `roles/run.invoker` to `clinic-web` (the web project's proxy identity) and `clinic-smoke` only (amended by ADR-0023 and the hosting decision in ADR-0023; no `allUsers` binding exists, so a direct request is an unbilled IAM denial). CI therefore never needs `setIamPolicy` and never passes `--allow-unauthenticated`. This also avoids running `--no-traffic` against a service that doesn't exist yet. Whether that is rejected is unverified; bootstrapping makes the question irrelevant.

**`ship-api`: one job, `serial-group: << pipeline.project.slug >>/deploy-prod`.**

1. Run the `clinic-migrate` job by image digest and `--wait`. Migrations are expand-only and take an advisory lock.
2. `gcloud run deploy --no-traffic --tag sha-<7>` by digest.
3. **egress-country gate (hosting lock review):** if CircleCI's egress country is not `US`, fail before any tag-URL call and promote nothing (CircleCI documents US-only job regions; the gate covers the undocumented egress address). Then run `scripts/verify_claims.py` against the tag URL. It uses fresh patients, chooses its slot dynamically and cleans up in `finally`. Because the service is IAM-gated, the script sends `X-Serverless-Authorization: Bearer <token>`, the token minted by `gcloud auth print-identity-token --impersonate-service-account=clinic-smoke@<project>.iam.gserviceaccount.com --audiences=clinic-api` (whether a custom audience is accepted on a tag URL is **unverified**; checks it, fallback audience = the tag URL itself).
4. If `CIRCLE_SHA1` is no longer the head of `origin/main`, skip promotion.
5. Otherwise `update-traffic --to-tags sha-<7>=100`, and prune tags beyond the last 2 (amended: Artifact Registry keeps 2 versions per package, so a third tag could point at a deleted image), then delete Artifact Registry versions beyond the newest 2.

**Stretch S1 additions (only if S1 ships).**

- **PR and release verify jobs:** `realtime-quality` (gofmt, go vet), `realtime-test` (primary `cimg/python:3.12` with a checksum-verified Go toolchain; creates both roles from the initdb scripts, migrates with `uv run alembic upgrade head` as the owner, then unit + `-tags=integration` against the `cimg/postgres:17.x` secondary image, including the out-of-order-commit test), `realtime-sec` (`govulncheck ./...`, `gosec ./...`).
- **Lean-core jobs touched by the realtime service:** `backend-test` runs `02-realtime-role.sql` after `01-roles.sql`, the `dast` compose stack mounts the same initdb directory, and `backend-quality` asserts a single alembic head. Migration `0003` skips its grants instead of failing when the role is missing, so `clinic-migrate` in `ship-api` cannot fail on a stretch role.
- **Release:** `build-scan-push-realtime` (trivy gate, push by digest) and `ship-realtime`. `ship-realtime` depends on `ship-api` (so migration `0003_event_cursor` is applied first) and runs under its own `serial-group: << pipeline.project.slug >>/deploy-prod-realtime`. Its steps mirror `ship-api`: OIDC → WIF, `gcloud run deploy clinic-realtime --no-traffic --tag sha-<7>` by digest, `scripts/verify_stream.py` against the tag URL (metrics cursor, heartbeat within 16 s, booked and cancelled events for its own fresh patient, exact resume, 422 on a bad cursor), the newer-commit guard, promote by tag, prune.
- **Isolation from the lean core:** `ship-web` depends on `ship-api` only, and no lean-core job depends on a realtime job, so a realtime failure never blocks the API or web release.
- **Bootstrap:** `infra/bootstrap.sh` creates `clinic-realtime` once from the hello image with `--no-allow-unauthenticated` and binds `roles/run.invoker` to `clinic-web` and `clinic-smoke`, as for the API (amended by ADR-0023). The admin boundary after S3 is the in-app ticket (ADR-0022), not IAM.
- **IAM:** the deployer gets `iam.serviceAccountUser` on `clinic-realtime-runtime`; no new roles at project level. With S3, the deployer also gets `roles/iam.serviceAccountTokenCreator` on the `clinic-smoke` service account only.
- **Smoke after S3:** `/admin/metrics` and `/stream` need credentials, but the positive stream check (metrics, ticket, heartbeat within 16 s, booked/cancelled events) is the only guard against Cloud Run buffering SSE frames, so it must not shrink to two 401 checks. `verify_stream.py` mints a `clinic-smoke` ID token by impersonation (audience = the OAuth client id; `clinic-smoke` is in `ADMIN_EMAILS`) and runs the full check against the tag URL. Whether the WIF-derived credential can mint it is unverified until runs it; if it cannot, S3 is dropped rather than weakening the smoke.

**Rollback.** A failed smoke means traffic never moved. A manual rollback is `gcloud run services update-traffic clinic-api --region us-east4 --to-revisions <prev>=100` (runbook; region amended from europe-west3). Only the previous revision is guaranteed to still have its image (2 versions per package).

**Credit budget (added by the $0 audit; a deduction until measures it).** CircleCI Free gives 30,000 credits a month with no card; at exhaustion personal builds are blocked, never billed (circleci.com/docs/guides/plans-pricing/credits, read 2026-10-16). Our worst-case month (30 PR + 10 main pipelines, every lane running) is about 22,200 credits, 26% headroom, without counting the open-source allowance (whose size the CircleCI pages state inconsistently). Rules that keep it there:

- `resource_class: small` for `backend-quality`, `secrets`, `sast`, `sca`, `contract-drift`, `cost-static`, `realtime-quality`, `realtime-sec`; `medium` for the rest; the `dast` machine executor at its default medium. Never `large`, never Gen2 classes. If `sast` runs out of memory on `small`, it moves to `medium` and the budget is recomputed.
- **No Docker layer caching** (200 credits per job). `restore_cache`/`save_cache` keyed on `uv.lock`, `pnpm-lock.yaml`, `go.sum`, and the Trivy DB keyed by date, kept small for the 2 GB storage allowance.
- **Self-skipping lanes, not path-filtered workflows.** The web and realtime jobs first run `git diff --name-only origin/main...HEAD` and call `circleci-agent step halt` when their paths are untouched, so a skipped job still reports green and branch protection keeps requiring it. The backend and security lane always runs on PRs. `release` never skips anything.
- Images are built with `docker buildx build --provenance=false --sbom=false`, so one push is one Artifact Registry version (attestation manifests would add versions, deduced) and the keep-2 rule and the two-version limit hold (cost verifier issue 6). CI never pulls from `*-docker.pkg.dev`: it scans the local build before the push, because Artifact Registry internet egress is billed from byte 0 (issue 5).
- Short artifact, cache and workspace retention set in Plan → Usage Controls; artifacts limited to JUnit, coverage XML and `zap-report.html`.
- Docker Official Images and the `cimg/*` executors are pulled through `mirror.gcr.io` (official images by digest), with no Docker Hub login and no `dockerhub-ro` context (engineer, 2026-10-16), so there is no Docker Hub credential to hold. Residual: the mirror is a cache of Docker Hub, so a `cimg` tag it has not cached falls through to Docker Hub's anonymous limit; the four tags in use resolved through it when checked (2026-10-16).

**Web deploy.** `vercel pull --yes --environment=production && vercel build --prod && vercel deploy --prebuilt --prod`. `web/vercel.json` disables Vercel's own Git deployments. Run with `--cwd web`; one project, which carries the proxy, so this job is lean core.

## Consequences

- Good: no long-lived GCP credentials anywhere. Only the smoke-tested revision is promoted. Concurrent merges cannot interleave.
- Proof required before we claim "branch builds cannot deploy": a saved WIF-deny log and a saved context-deny log.
- Bad: `VERCEL_TOKEN` is long-lived. It is project-scoped and rotated after grading. With the proxy inside the `web` project (ADR-0023) it is lean core.
- Good: `cost-check` turns cost drift (an unset max-instances, a growing image repository, an extra secret version, an `allUsers` binding) into a red release, not a surprise invoice.
- Bad: about 10-12 minutes per main pipeline (estimate). The realtime lane runs in parallel with `ship-web`; its added wall time is unmeasured.
- Unverified: whether branch protection requiring CircleCI checks needs a public repo on the current GitHub plan. The repo is public anyway.

## Assessment line

Section 3: "CI/CD runs tests on every PR and auto-deploys on merge to a designated branch"; "which branch deploys and how, what the pipeline does".

## Review trigger

A staging environment. That means an approval job, a second WIF provider condition, and a separate context.
