# Runbook: GCP, CircleCI, Neon and Vercel bootstrap

One-time setup, done by the engineer. Nothing in CI creates infrastructure; CI only deploys.
Steps are numbered in the order they must run. Several depend on IDs the previous step
produces, so do not reorder them.

Set these once per shell (every later block assumes them). The machine's active gcloud
account is a different one, so **every `gcloud` call passes `--account`**:

```bash
export PROJECT=sil-clinic-booking
export GCLOUD_ACCOUNT=developer.ericgitangu@gmail.com
export BILLING_ACCOUNT=<dedicated billing account id>   # Paid, not a Free Trial
export REGION=us-east4
```

Every `bootstrap.sh` mode is re-runnable and honours `DRY_RUN=1` (prints each command, runs
nothing). Dry-run first, read the output, then run it for real.

## 0. Project and billing

```bash
DRY_RUN=1 bash infra/bootstrap.sh project
bash infra/bootstrap.sh project          # creates the project, links billing, enables the bootstrap APIs
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --account "$GCLOUD_ACCOUNT" --format='value(projectNumber)')
echo "$PROJECT_NUMBER"
```

Why the APIs here: `gcloud run deploy` would otherwise stop at an interactive "enable API?"
prompt, and Terraform needs `serviceusage` and `cloudresourcemanager` before it can enable
anything else. Terraform owns every other API after step 4.

## 1. Terraform state bucket

```bash
bash infra/bootstrap.sh state
```

## 2. GitHub repository and CircleCI

1. Make sure `ericgitangu/clinic-booking` exists (public) and push `main`.
2. CircleCI -> Projects -> Set Up Project -> GitHub App -> use the existing
   `.circleci/config.yml`.
3. **The first pipeline that starts here is expected to fail** (the contexts do not exist
   yet). It cannot deploy anything: the Workload Identity pool does not exist until step 4.
4. Read the two IDs Terraform needs (dashboard only; the local CLI config could not be parsed):
   - org id: Organization Settings -> Overview -> Organization ID
   - project id: Project Settings -> Overview -> Project ID
5. Project Settings -> Advanced, set both to **off**:
   - Build forked pull requests
   - Pass secrets to builds from forked pull requests

   CircleCI issues OIDC tokens to forked builds only when the second one is on. A fork that
   names its branch `main` otherwise looks like the real branch to the Workload Identity
   condition.

## 3. CircleCI contexts

Organization Settings -> Contexts. A job that references a context that does not exist fails
at start, and every workflow job references one, so create all four before the first push to
`main`.

| Context | Variables | Restriction |
|---|---|---|
| `gcp-deploy` | `GOOGLE_PROJECT_ID` = `$PROJECT`; `GOOGLE_PROJECT_NUMBER` = `$PROJECT_NUMBER`; `DEPLOYER_SA` = `circleci-deployer@$PROJECT.iam.gserviceaccount.com`; `PUBLIC_BASE_URL` = `$WEB/api` (step 7); `WEB_ORIGIN` = `$WEB` (step 7) | `pipeline.git.branch == "main"` |
| `dockerhub-ro` | `DOCKERHUB_USER`, `DOCKERHUB_PASS` (a **read-only** access token from a free Docker Hub account: Account Settings -> Personal access tokens) | none (pull-request builds need it) |
| `vercel-prod` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (step 7) | `pipeline.git.branch == "main"` |
| `oidc-probe` | none | none; used only by the negative test below |

Open `gcp-deploy` and copy its UUID from the page URL. Terraform needs it: only jobs that use
this context can mint a deployer token.

```bash
export GCP_DEPLOY_CONTEXT_ID=<uuid of gcp-deploy>
```

## 4. Terraform

Terraform and its `gcs` backend use Application Default Credentials, **not** `--account`.
Point them at the engineer's account and project explicitly:

```bash
gcloud auth application-default login --account "$GCLOUD_ACCOUNT"
gcloud auth application-default set-quota-project "$PROJECT"
# alternative without touching the ADC file:
#   export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account "$GCLOUD_ACCOUNT")
```

```bash
cd infra/terraform
terraform init -backend-config="bucket=clinic-tfstate-$PROJECT"
cp terraform.tfvars.example terraform.tfvars    # gitignored; identifiers only, no secrets
$EDITOR terraform.tfvars   # project_number, billing_account, circleci_org_id,
                           # circleci_project_id, circleci_gcp_deploy_context_id
terraform plan -out tfplan
bash ../plan_gate.sh tfplan      # cost gate: exits non-zero on any banned resource, or if it cannot run
terraform apply tfplan
cd ../..
```

`plan_gate.sh` fails closed: a missing `rg`, a failing `terraform show` or an empty plan is a
failure. Do not apply unless it printed `plan_gate: clean`.

## 5. Cloud Run service and invoker bindings

Needs the runtime and web/smoke service accounts from step 4.

```bash
DRY_RUN=1 bash infra/bootstrap.sh service invoker
bash infra/bootstrap.sh service invoker
```

`run.invoker` is granted to `clinic-web` and `clinic-smoke` only (never `allUsers`), on
`clinic-api` and, if it exists, `clinic-realtime`. Capture the service URL:

```bash
export RUN_APP_URL=$(gcloud run services describe clinic-api --account "$GCLOUD_ACCOUNT" \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)')
echo "$RUN_APP_URL"
```

## 6. Neon

Follow `docs/runbooks/neon.md`, including adding both secret versions.

## 7. Vercel (and the URLs the rest depends on)

```bash
export TEAM=eric-gitangus-projects
vercel project add clinic-web --scope "$TEAM"
```

1. Dashboard -> `clinic-web` -> Settings -> Security -> OIDC Federation: confirm the issuer
   mode is **Team** (dashboard-only toggle).
2. Settings -> General -> Root Directory: leave **empty** (CI passes `--cwd web`).
3. Link and read the identifiers:
   ```bash
   (cd web && vercel link --yes --project clinic-web --scope "$TEAM")
   cat web/.vercel/project.json            # orgId and projectId; gitignored identifiers
   ```
4. Put `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` in the `vercel-prod` context.
5. Production environment variables (identifiers only, no secrets). `vercel env add` prompts
   unless the value arrives on stdin:
   ```bash
   addenv() { printf %s "$2" | vercel env add "$1" production --cwd web --scope "$TEAM"; }
   addenv API_URL "$RUN_APP_URL"
   addenv API_AUDIENCE clinic-api
   addenv GCP_PROJECT_NUMBER "$PROJECT_NUMBER"
   addenv GCP_SERVICE_ACCOUNT_EMAIL "clinic-web@$PROJECT.iam.gserviceaccount.com"
   addenv GCP_WORKLOAD_IDENTITY_POOL_ID vercel
   addenv GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID vercel
   addenv RATE_LIMIT_PER_MINUTE 120
   vercel env ls production --cwd web --scope "$TEAM"     # all seven names listed
   ```
6. Read the production URL (Project -> Domains, or `vercel project inspect`), then:
   ```bash
   export WEB=https://<clinic-web production domain>
   ```
   - add `PUBLIC_BASE_URL=$WEB/api` and `WEB_ORIGIN=$WEB` to the `gcp-deploy` context;
   - write both URLs into `scripts/ci/public-urls.env` (`WEB=` and `RUN_APP_URL=`) and commit
     it **before the first push to `main`**. `smoke-public` fails fast while the placeholders
     remain, so skipping this makes the first release red at its last job.

## 8. Spend cap (before the first push to main)

Terraform creates two budgets: `clinic-alerts-1usd` (alerts) and `clinic-run-spend-cap-3usd`
(a **gross** $3 budget scoped to this project and Cloud Run, credits excluded). Neither the
Terraform provider nor the CLI has any attribute that pauses or caps usage, so turning the
second one into an enforced cap is a console action, and **whether this billing account can
enforce it is UNVERIFIED**.

1. Console -> Billing -> Budgets & alerts -> `clinic-run-spend-cap-3usd`: enable the
   usage-pausing / cap action if the console offers it for this account. Screenshot it.
2. Confirm both budgets exist:
   ```bash
   gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --account "$GCLOUD_ACCOUNT" \
     --format='value(displayName)'
   ```
   Expected: `clinic-alerts-1usd` and `clinic-run-spend-cap-3usd`.
3. Record the budget id and the outcome here: `BUDGET_ID=<fill in>`; cap action: `<enabled | not offered>`.

If the console does not offer a cap for this account, the remaining protection is
`--max-instances 3`, IAM-only access, the egress alert and the free-tier arithmetic in the
cost proof. Say so in the README.

## 9. First release

Push to `main`. The `release` workflow runs the verify jobs, builds and scans the image,
migrates, deploys a tagged no-traffic revision, smokes it, promotes, ships the web project and
runs the public smoke. If the URLs in step 7 were guessed wrong, `smoke-public` is the job
that goes red; fix `scripts/ci/public-urls.env` and push again.

### First-deploy checks (all UNVERIFIED until run live)

Each of these can only be proven against the real accounts. Do them in order on the first
release and write the observed result next to each.

| Check | Command | Expected | If not |
|---|---|---|---|
| Vercel OIDC -> `generateIdToken` (direct federated, no impersonation hop) | `curl -s -o /dev/null -w '%{http_code}' "$WEB/api/healthz"` | `200` | `502` with `UPSTREAM_AUTH_FAILED`: read `vercel logs`; the proxy logs the STS or IAM status. Switch the role on `clinic-web` in `wif_vercel.tf` to `roles/iam.workloadIdentityUser`, re-apply, retry. |
| Cloud Run is IAM-only | `curl -s -o /dev/null -w '%{http_code}' "$RUN_APP_URL/healthz"` | `403` | any `200`: stop, check `run.invoker` bindings for `allUsers`. |
| WIF accepts only the deploy context | `test/wif-deny` branch, a job on context `oidc-probe` that attempts the token exchange | permission denied | the attribute condition in `wif.tf` is not enforcing the context claim. |
| WIF accepts the deploy job | the first `ship-api` run | green login step | `Permission denied` at `gcp_login.sh`: compare the token's `oidc.circleci.com/*` claims with `local.circleci_attribute_condition`. |
| Artifact Registry prune permissions | after the third release, `cost-check` job (C6) | every package at <= 2 versions | the `clinicImagePruner` role lacks a permission the delete needs. |
| Billing report | Billing -> Reports, group by SKU, 48 h after the first release | every SKU `$0.00` after savings | investigate before further releases. |

Save the log URLs of the two negative tests (WIF deny, context deny) here:
`<fill in>`.

```bash
GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" PROJECT="$PROJECT" make cost-check     # read-only live guards
```

## Accepted risks

- **Deployer blast radius.** `run.developer` is project-wide and the deployer can act as the
  migrate and runtime service accounts, so any job that can mint the deployer token can deploy
  a Cloud Run job with an arbitrary command under the migrate identity. The Workload Identity
  condition (project, repository, `main`, the `gcp-deploy` context) is the control; keep the
  context restricted to `main`, and keep fork builds off (step 2). Scoping `run.developer` to
  the individual service and job is the next tightening.
- **Rate limiting is per warm instance** on the Vercel proxy. It bounds a single client, not
  a distributed one.

## Manual cost checks (screenshots)

- Spend-cap action (step 8); one project on the billing account; Vercel Hobby with no card;
  CircleCI month-to-date credits with no card; Billing -> Reports 48 h after the first
  release (gross and free-tier savings per SKU); CircleCI Plan -> Usage Controls at the
  minimum retention.
