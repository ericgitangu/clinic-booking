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
export WEB=https://clinic.ericgitangu.com   # the booking app (ADR-0028); the admin app is https://clinic-admin.ericgitangu.com
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

Vercel keeps previous production deployments for each app (`clinic-web` is the booking app, `clinic-admin` the admin app): Vercel dashboard, the project, Deployments,
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

After `ship-booking` and `ship-admin`, `verify-release` (no credentials) runs `scripts/ci/public_smoke.sh`, which
includes `/ready` through the public URL, for about 90 seconds of retries (cold starts). If it
still fails, `rollback-api` (only the `gcp-deploy` context) runs `scripts/ci/rollback.sh`, then
`rollback-booking` and `rollback-admin` (both the `rollback-app` job, only the `vercel-prod` context) point production at the previous deployment of each app by
id (`scripts/ci/vercel_prod.sh rollback <id>`), and `smoke-public` fails so the release stays red.

- `rollback.sh` reads `keep.json` from `promote.sh` and refuses (exit 2) when there is no previous
  revision, when the previous one is not an image from this project's `clinic` registry (the
  placeholder hello image would take the API down), or when production is no longer on the
  revision this release promoted. If it refuses, the web rollback does not run and the pipeline
  fails loudly.
- Migrations are expand-only (`scripts/migration_lint.sh`), so the previous revision still runs
  against the migrated database. That is why a traffic move is a safe rollback.
- `vercel rollback` turns off automatic alias assignment. `ship-booking` and `ship-admin` therefore record the live
  deployment id first and, after every deploy, checks that the public alias serves the new
  deployment (promoting it if not).

After any Vercel rollback, automatic alias assignment stays off until the next release. The next
`ship-booking` / `ship-admin` run restores it: its `ensure` step sees the public alias is not serving the new
deployment and promotes it, then fails the job if it still is not.

Deploy markers (`circleci run release plan` / `update`) are recorded for `clinic-api`,
`clinic-web` and `clinic-admin`. The automatic rollback restores both apps after the API; `VERCEL_APP=admin` makes `vercel_prod.sh` work on the admin host. `.circleci/rollback.yml` is the manual, one-click rollback for the CircleCI UI. It
uses the same guards (`rollback.sh --to-tag` also checks the tag exists). Its API job goes to the
tagged revision it is given, but its web job always goes to the previous production deployment and
ignores `TARGET_VERSION`, because Vercel deployments are not tagged with the release and must be activated once
under Project Settings -> Deploys -> Rollback Pipeline (UI only). CircleCI's own *automatic*
rollback also needs the continuous-validation level and a monitor sending webhooks (Datadog,
Prometheus-compatible or a custom HTTP POST); it is not turned on here.

### When the Vercel token is refused (403)

`scripts/ci/vercel_prod.sh` stops with "the Vercel token was refused (403)" when `VERCEL_TOKEN` cannot read the deployment behind a host. Both apps use the `vercel-prod` context, so the token must be a team-scoped token that can see **both** projects (`clinic-web` and `clinic-admin`). The ship and rollback jobs print `Vercel target: app=… project=… team=…` first, so the logs show which project id the job used. To fix a refused token, create a new team-scoped token and update `VERCEL_TOKEN` in the context.

## A web app that is missing settings

Before `ship-booking` and `ship-admin` deploy, `scripts/ci/vercel_env_check.sh` lists the names (never
the values) of the project's production variables and refuses the ship if any name in
`scripts/ci/required_env.txt` is absent. If one slips through anyway, the sign-in routes answer a
503 "Sign-in is not configured" page and log one `auth_not_configured` line naming the missing
variables, so the fix is to add them in Vercel and redeploy; no rollback is needed for that alone.

## Kill switch (daily egress alert)

`bash scripts/ops/kill_switch.sh` is a dry run: it reads the IAM policies of `clinic-api` and
`clinic-realtime` and prints which `roles/run.invoker` bindings it would remove. `--apply` records
the prior policy to `~/.clinic-kill-switch/state.json` first, then removes the `clinic-web` and
`clinic-admin` bindings from both services, so every request becomes an unbilled IAM denial after
the propagation delay (`clinic-smoke` is left alone). `bash scripts/ops/kill_switch.sh --restore --apply`
re-adds exactly the bindings it removed and checks the invoker members match the recorded policy.
It only acts on `sil-clinic-booking` in `us-east4` and refuses anything else; a missing
`clinic-realtime` is skipped.

## Vercel tokens: one per project

The `vercel-prod` context holds two project-scoped tokens: `VERCEL_TOKEN` (`clinic-web`, the booking app) and `VERCEL_ADMIN_TOKEN` (`clinic-admin`). Each app's `ship-` and `rollback-` job picks its own with `scripts/ci/select_vercel_token.sh`, so a booking job never uses the admin token and the reverse. If an admin job stops with "VERCEL_ADMIN_TOKEN is not set", add a `clinic-admin` scoped token to the `vercel-prod` context under that name; nothing was deployed or rolled back. If a Vercel step answers 403, check that the job's token is scoped to the project that job is about.
