# Runbook: rollback

Releases are tagged revisions: `ship-api` deploys with `--no-traffic --tag sha-<7>`, smokes the
tag URL, then moves 100% traffic to it. The previous revision keeps its tag (the newest two
tags and the newest two Artifact Registry versions are retained), so rollback is a traffic
move, not a rebuild.

## API

```bash
gcloud run services describe clinic-api --region us-east4 --project "$PROJECT" \
  --format=json | jq -r '.status.traffic[] | [.tag, .percent, .revisionName] | @tsv'

# send 100% back to the previous tag
gcloud run services update-traffic clinic-api --region us-east4 --project "$PROJECT" \
  --to-tags "sha-<previous>=100"
```
Never use `--to-latest`. Confirm: `curl -fsS "$PUBLIC_API/readyz"` returns 200 and
`python scripts/verify_claims.py --base-url "$PUBLIC_API"` is all PASS.

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
