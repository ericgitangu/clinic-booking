# Runbook: rollback

Releases are tagged revisions: `ship-api` deploys with `--no-traffic --tag sha-<7>`, smokes the
tag URL, then moves 100% traffic to it. The previous revision keeps its tag (the newest two
tags and the newest two Artifact Registry versions are retained), so rollback is a traffic
move, not a rebuild.

Variables (same as `docs/runbooks/bootstrap-gcp.md`); every `gcloud` call passes `--account`
because the machine's active account is a different one:

```bash
export PROJECT=sil-clinic-booking
export GCLOUD_ACCOUNT=developer.ericgitangu@gmail.com
export WEB=https://<clinic-web production domain>
export PUBLIC_API="$WEB/api"
```

## API

```bash
gcloud run services describe clinic-api --region us-east4 --project "$PROJECT" \
  --account "$GCLOUD_ACCOUNT" \
  --format=json | jq -r '.status.traffic[] | [.tag, .percent, .revisionName] | @tsv'

# send 100% back to the previous tag
gcloud run services update-traffic clinic-api --region us-east4 --project "$PROJECT" \
  --account "$GCLOUD_ACCOUNT" --to-tags "sha-<previous>=100"
```

Never use `--to-latest`. Confirm: `curl -fsS "$PUBLIC_API/ready"` returns 200 and
`python3 scripts/verify_claims.py --base-url "$PUBLIC_API"` is all PASS.

The release keeps exactly two rollback candidates: the revision that is live and the one that
was live before it. A release that was skipped because a newer commit landed is not a
candidate and is pruned.

## Web

Vercel keeps previous production deployments: Vercel dashboard, `clinic-web`, Deployments,
pick the last good one, "Promote to Production" (or `vercel rollback --scope <team>`).
Roll the API back first if the web build shipped a contract the old API lacks, and the web
second so the two never disagree.

## Database

Migrations are expand-only (ADR-0015), so rolling the API back never needs a schema rollback:
old code runs against the newer schema. Do not run `alembic downgrade` against prod. A bad
data change is fixed forward with a new migration.

## If the CVE or image is the problem

Follow `docs/runbooks/base-image-cve.md`, then re-release.

## Automatic rollback

After `ship-web`, `verify-release` (no credentials) runs `scripts/ci/public_smoke.sh`, which
includes `/ready` through the public URL, for about 90 seconds of retries (cold starts). If it
still fails, `rollback-api` (only the `gcp-deploy` context) runs `scripts/ci/rollback.sh`, then
`rollback-web` (only the `vercel-prod` context) points production at the previous deployment by
id (`scripts/ci/vercel_prod.sh rollback <id>`), and `smoke-public` fails so the release stays red.

- `rollback.sh` reads `keep.json` from `promote.sh` and refuses (exit 2) when there is no previous
  revision, when the previous one is not an image from this project's `clinic` registry (the
  placeholder hello image would take the API down), or when production is no longer on the
  revision this release promoted. If it refuses, the web rollback does not run and the pipeline
  fails loudly.
- Migrations are expand-only (`scripts/migration_lint.sh`), so the previous revision still runs
  against the migrated database. That is why a traffic move is a safe rollback.
- `vercel rollback` turns off automatic alias assignment. `ship-web` therefore records the live
  deployment id first and, after every deploy, checks that the public alias serves the new
  deployment (promoting it if not).

After any Vercel rollback, automatic alias assignment stays off until the next release. The next
`ship-web` run restores it: its `ensure` step sees the public alias is not serving the new
deployment and promotes it, then fails the job if it still is not.

Deploy markers (`circleci run release plan` / `update`) are recorded for `clinic-api` and
`clinic-web`. `.circleci/rollback.yml` is the manual, one-click rollback for the CircleCI UI. It
uses the same guards (`rollback.sh --to-tag` also checks the tag exists). Its API job goes to the
tagged revision it is given, but its web job always goes to the previous production deployment and
ignores `TARGET_VERSION`, because Vercel deployments are not tagged with the release and must be activated once
under Project Settings -> Deploys -> Rollback Pipeline (UI only). CircleCI's own *automatic*
rollback also needs the continuous-validation level and a monitor sending webhooks (Datadog,
Prometheus-compatible or a custom HTTP POST); it is not turned on here.
