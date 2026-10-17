# Runbook: GCP, CircleCI, Neon and Vercel bootstrap

One-time setup, done by the engineer. Nothing in CI creates infrastructure; CI only deploys.
Steps are numbered in the order they must run. Several depend on IDs the previous step
produces, so do not reorder them.

Set these once per shell (every later block assumes them). The machine's active gcloud
account is a different one, so **every `gcloud` call passes `--account`**:

```bash
export PROJECT=sil-clinic-booking
export GCLOUD_ACCOUNT=the.ace.guru@gmail.com                  # project Owner: every IAM, Terraform and WIF step
export BILLING_GCLOUD_ACCOUNT=developer.ericgitangu@gmail.com   # billing and budget steps only
export BILLING_ACCOUNT=01C382-12CD13-DCA6EF                     # SHARED "Firebase Payment" account (see ADR-0014)
export REGION=us-east4
```

The two accounts are not interchangeable. `the.ace.guru` is the project Owner (the project was
created there because `developer.ericgitangu` hit Google's project-creation quota). `developer`
holds only `roles/editor` on the project and `roles/billing.projectManager`, so it runs the
billing and budget steps and nothing that sets IAM. The billing account is shared with four
other projects: read the cost analysis in ADR-0014.8 before relying on "$0".

Every `bootstrap.sh` mode is re-runnable and honours `DRY_RUN=1` (prints each command, runs
nothing). Dry-run first, read the output, then run it for real.

## 0. Project and billing: DONE (2026-10-16)

`bootstrap.sh project` has been run. Do not run it again. Recorded facts, read live by the
main session (not re-created here): project `sil-clinic-booking`, number `291652953712`,
ACTIVE; Owner `the.ace.guru@gmail.com`; linked to the shared billing account
`01C382-12CD13-DCA6EF`, `billingEnabled=True`; APIs enabled: serviceusage,
cloudresourcemanager, storage, run. The project was created as `the.ace.guru` because
`developer.ericgitangu` hit Google's project-creation quota; no dedicated billing account could
be opened (5 of 5 slots in use), which is the engineer's decision.

```bash
export PROJECT_NUMBER=291652953712
gcloud projects describe "$PROJECT" --account "$GCLOUD_ACCOUNT" --format='value(projectNumber,lifecycleState)'   # read-only check
```

Why the APIs here: `gcloud run deploy` would otherwise stop at an interactive "enable API?"
prompt, and Terraform needs `serviceusage` and `cloudresourcemanager` before it can enable
anything else. Terraform owns every other API after step 4.

## 1. Terraform state bucket

Dry-run first (prints each command, runs nothing), then run it as the Owner:

```bash
DRY_RUN=1 PROJECT="$PROJECT" GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" bash infra/bootstrap.sh state
PROJECT="$PROJECT" GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" bash infra/bootstrap.sh state
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
at start, so create all three before the first push to
`main`.

| Context | Variables | Restriction |
|---|---|---|
| `gcp-deploy` | `GOOGLE_PROJECT_ID` = `$PROJECT`; `GOOGLE_PROJECT_NUMBER` = `$PROJECT_NUMBER`; `DEPLOYER_SA` = `circleci-deployer@$PROJECT.iam.gserviceaccount.com`; `PUBLIC_BASE_URL` = `$WEB/api` (step 7); `WEB_ORIGIN` = `$WEB` (step 7) | `pipeline.git.branch == "main"` |
| `vercel-prod` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (step 7) | `pipeline.git.branch == "main"` |
| `oidc-probe` | none | none; used only by the negative test below |

Open `gcp-deploy` and copy its UUID from the page URL. Terraform needs it: only jobs that use
this context can mint a deployer token.

```bash
export GCP_DEPLOY_CONTEXT_ID=<uuid of gcp-deploy>
```

## 4. Terraform

Terraform and its `gcs` backend do not read `--account`. `gcloud auth application-default login`
takes no account flag either, so it would sign in as whoever you pick in the browser. Pin the
identity instead with an access token minted for the account and verify it:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account "$GCLOUD_ACCOUNT")
# the token is short-lived (1 h); re-export when Terraform reports 401. Confirm the identity first:
curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$GOOGLE_OAUTH_ACCESS_TOKEN" | jq -r .email   # must print the.ace.guru@gmail.com
```

```bash
cd infra/terraform
terraform init -backend-config="bucket=clinic-tfstate-$PROJECT"
cp terraform.tfvars.example terraform.tfvars    # gitignored; identifiers only, no secrets
$EDITOR terraform.tfvars   # project_number (291652953712), circleci_org_id,
                           # circleci_project_id, circleci_gcp_deploy_context_id
terraform plan -out tfplan
bash ../plan_gate.sh tfplan      # cost gate: exits non-zero on any banned resource, or if it cannot run
terraform apply tfplan
cd ../..
```

`plan_gate.sh` fails closed: a missing `rg`, a failing `terraform show` or an empty plan is a
failure. Do not apply unless it printed `plan_gate: clean`.

This apply also removes `roles/editor` from the default Compute service account
(`default_sa.tf`, `google_project_iam_member_remove`); the plan should show that one binding
being removed and nothing else. (The provider's `google_project_default_service_accounts` was tried
first and changed nothing here.) Our services never use that account (every
deploy passes `--service-account`). Verify afterwards (read-only):

```bash
gcloud projects get-iam-policy "$PROJECT" --account "$GCLOUD_ACCOUNT" --format=json \
  | jq -r --arg m "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
      '[.bindings[] | select(.role == "roles/editor") | .members[] | select(. == $m)] | length'
```

Expected: `0` (`make cost-check` the default-SA check asserts the same). UNVERIFIED until applied.

## 5. Cloud Run service and invoker bindings

Needs the runtime and web/admin/smoke service accounts from step 4.

```bash
DRY_RUN=1 bash infra/bootstrap.sh service invoker
bash infra/bootstrap.sh service invoker
```

`run.invoker` is granted to `clinic-web`, `clinic-admin` and `clinic-smoke` only (never `allUsers`), on
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
2. Settings -> General -> Root Directory: **`apps/booking`** (the pnpm workspace keeps dependencies in the root `node_modules`; building or deploying with `--cwd` fails on missing files, so CI builds and deploys from the repo root). Set by API: `vercel api -X PATCH "/v9/projects/$VERCEL_PROJECT_ID?teamId=$VERCEL_ORG_ID" -f rootDirectory=apps/booking`. Also confirm Settings -> Functions -> Function Region is **US East (iad1)**; see the first-deploy check below.
3. Link and read the identifiers:

   ```bash
   vercel link --yes --project clinic-web --scope "$TEAM"   # from the repo root
   cat .vercel/project.json                # orgId and projectId; gitignored identifiers
   ```

4. Put `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` in the `vercel-prod` context.
5. Production environment variables (identifiers only, no secrets). `vercel env add` prompts
   unless the value arrives on stdin:

   ```bash
   addenv { printf %s "$2" | vercel env add "$1" production --scope "$TEAM"; }
   addenv API_URL "$RUN_APP_URL"
   addenv API_AUDIENCE clinic-api
   addenv GCP_PROJECT_NUMBER "$PROJECT_NUMBER"
   addenv GCP_SERVICE_ACCOUNT_EMAIL "clinic-web@$PROJECT.iam.gserviceaccount.com"
   addenv GCP_WORKLOAD_IDENTITY_POOL_ID vercel
   addenv GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID vercel
   addenv RATE_LIMIT_PER_MINUTE 120
   vercel env ls production --scope "$TEAM"     # all seven names listed
   ```

6. Read the production URL (Project -> Domains, or `vercel project inspect`), then:

   ```bash
   export WEB=https://sil-clinic-booking.vercel.app   # clinic-web.vercel.app is taken
   vercel api -X POST "/v10/projects/$VERCEL_PROJECT_ID/domains?teamId=$VERCEL_ORG_ID" -f name=sil-clinic-booking.vercel.app
   # Adding it as a project domain (not just `vercel alias set`) is what makes it public: a plain
   # alias on a *.vercel.app name sits behind Vercel's deployment protection and redirects to a login.
   ```

   - note (2026-10-18): the public hostnames are now `https://clinic.ericgitangu.com` (booking) and `https://clinic-admin.ericgitangu.com` (admin), per ADR-0028; the `sil-clinic-booking.vercel.app` name above is the cut-over alias. `scripts/ci/public-urls.env` holds the real values;
   - add `PUBLIC_BASE_URL=$WEB/api` and `WEB_ORIGIN=$WEB` to the `gcp-deploy` context;
   - write both URLs into `scripts/ci/public-urls.env` (`WEB=` and `RUN_APP_URL=`) and commit
     it **before the first push to `main`**. `smoke-public` fails fast while the placeholders
     remain, so skipping this makes the first release red at its last job.

## 8. Spend cap (before the first push to main)

The budgets live in their own Terraform root, `infra/billing`, because creating them needs
billing rights on the shared account, which only `developer.ericgitangu` has (whether
`roles/billing.projectManager` is enough to create budgets is UNVERIFIED; if the apply is
refused, create them in the console with the same names and amounts). Run it as the billing
user, after step 4 has enabled `billingbudgets.googleapis.com`:

```bash
# pin the billing identity with a token (ADC login has no account flag), then verify it
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account "$BILLING_GCLOUD_ACCOUNT")
# the token is short-lived (1 h); re-export when Terraform reports 401. Confirm the identity first:
curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$GOOGLE_OAUTH_ACCESS_TOKEN" | jq -r .email   # must print developer.ericgitangu@gmail.com
cd infra/billing
terraform init -backend-config="bucket=clinic-tfstate-$PROJECT"
cp terraform.tfvars.example terraform.tfvars   # already holds the shared account id and project number
terraform plan -out tfplan && bash ../plan_gate.sh tfplan
terraform apply tfplan
cd ../..
```

It creates two budgets: `clinic-alerts-1usd` (alerts, on this project's gross spend, **not** the
whole account: the account already bills about $5 a month for the other projects) and `clinic-run-spend-cap-3usd`
(a **gross** $3 budget scoped to this project and Cloud Run, credits excluded). Neither the
Terraform provider nor the CLI has any attribute that pauses or caps usage, so turning the
second one into an enforced cap is a console action, and **whether this billing account can
enforce it is UNVERIFIED**.

1. Console -> Billing -> Budgets & alerts -> `clinic-run-spend-cap-3usd`: enable the
   usage-pausing / cap action if the console offers it for this account. Screenshot it.
2. Confirm both budgets exist:

   ```bash
   gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --account "$BILLING_GCLOUD_ACCOUNT" \
     --billing-project "$PROJECT" \
     --format='value(displayName)'
   ```

   Expected: `clinic-alerts-1usd` and `clinic-run-spend-cap-3usd`.
3. Record the budget id and the outcome here: `BUDGET_ID=<fill in>`; cap action: `<enabled | not offered>`.

**Verified 2026-10-18 in the Cloud Billing console:** both clinic budgets show "Spend cap status: Not applicable", so they are alerts-only, and month-to-date gross is $0.02 on each. An existing budget cannot be converted into a spend cap; a cap must be created as a new budget in the console ([guide](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)). That has not been approved or done. Until the console shows "Configured", treat `clinic-run-spend-cap-3usd` as an alert, not a cap.

If the console does not offer a cap for this account, the remaining protection is
`--max-instances 3`, IAM-only access, the egress alert and the free-tier arithmetic in the
cost proof. Say so in the README.

## 9. First release

Push to `main`. The `release` workflow runs the verify jobs, builds and scans the image,
migrates, deploys a tagged no-traffic revision, smokes it, promotes, ships the booking and admin apps and
runs the public smoke. If the URLs in step 7 were guessed wrong, `smoke-public` is the job
that goes red; fix `scripts/ci/public-urls.env` and push again.

### First-deploy checks (all UNVERIFIED until run live)

Each of these can only be proven against the real accounts. Do them in order on the first
release and write the observed result next to each.

| Check | Command | Expected | If not |
|---|---|---|---|
| Vercel OIDC -> `generateIdToken` (direct federated, no impersonation hop) | `curl -s -o /dev/null -w '%{http_code}' "$WEB/api/health"` | `200` | `502` with `UPSTREAM_AUTH_FAILED`: read `vercel logs`; the proxy logs the STS or IAM status. Switch the role on `clinic-web` in `wif_vercel.tf` to `roles/iam.workloadIdentityUser`, re-apply, retry. |
| Vercel functions run in `iad1` only | Vercel dashboard -> the first production deployment -> Functions: the region column | `iad1` (Washington, D.C.) for `/api/[...path]` | The release builds the output offline (`scripts/ci/vercel_offline_build.sh`, so no Vercel token is present during install or build). A local build of that output does **not** carry the `regions: ["iad1"]` pin from `apps/booking/vercel.json` (observed: no `iad1` anywhere in `.vercel/output`), and I could not prove here that a prebuilt deploy applies it. `iad1` is also Vercel's default function region. If the dashboard shows anything else, set Settings -> Functions -> Function Region to `iad1` and redeploy. |
| Cloud Run is IAM-only | `curl -s -o /dev/null -w '%{http_code}' "$RUN_APP_URL/health"` | `403` | any `200`: stop, check `run.invoker` bindings for `allUsers`. |
| WIF accepts only the deploy context | `test/wif-deny` branch, a job on context `oidc-probe` that attempts the token exchange | permission denied | the attribute condition in `wif.tf` is not enforcing the context claim. |
| WIF accepts the deploy job | the first `ship-api` run | green login step | `Permission denied` at `gcp_login.sh`: compare the token's `oidc.circleci.com/*` claims with `local.circleci_attribute_condition`. |
| Artifact Registry prune permissions | after the third release, `cost-check` job | every package at <= 2 versions | the `clinicImagePruner` role lacks a permission the delete needs. |
| Billing report | Billing -> Reports, group by SKU, 48 h after the first release | every SKU `$0.00` after savings | investigate before further releases. |

Save the log URLs of the two negative tests (WIF deny, context deny) here:
`<fill in>`.

```bash
# In CI (release workflow) the same script runs as the deployer with read-only roles; the billing
# checks (budgets and the project list) are SKIPPED there because the deployer must never hold a
# role on the shared billing account, so run them here as BILLING_GCLOUD_ACCOUNT.
# read-only live guards; GCLOUD_ACCOUNT makes every call use your account, BILLING_ACCOUNT
# and BILLING_GCLOUD_ACCOUNT enable the budget checks, NEON_PROJECT_ID enables the Neon check (otherwise reported as SKIP)
GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" BILLING_GCLOUD_ACCOUNT="$BILLING_GCLOUD_ACCOUNT" PROJECT="$PROJECT" BILLING_ACCOUNT="$BILLING_ACCOUNT" make cost-check
```

## reCAPTCHA key (web app bot protection)

Everything stays in the `sil-clinic-booking` project; pass `--project` on every call. Terraform enables the API and creates the `clinic-recaptcha` service account first (infra/terraform), then:

```bash
gcloud recaptcha keys create --web --integration-type=score \
  --domains=sil-clinic-booking.vercel.app,localhost,clinic.ericgitangu.com --display-name=clinic-web \
  --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
gcloud recaptcha keys list --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
```

The key id printed is the public site key: set it as `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` in Vercel (production) and in the gitignored `apps/booking/.env.local`. There is no secret: the BFF calls the API as `clinic-recaptcha` through the Vercel identity (ADR-0022).

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

## Admin app identity and project

The admin app is a second Vercel project, `clinic-admin`, with its own service account. `infra/terraform` creates `clinic-admin@<project>` and lets only the `clinic-admin` production Vercel subject mint ID tokens for it; the OIDC provider admits exactly the `clinic-web` and `clinic-admin` production subjects. Then:

```bash
bash infra/bootstrap.sh invoker    # run.invoker for clinic-web, clinic-admin and clinic-smoke
vercel project add clinic-admin --scope "$TEAM"
vercel api -X PATCH "/v9/projects/clinic-admin?teamId=$VERCEL_ORG_ID" -f rootDirectory=apps/admin -f framework=nextjs
vercel domains add clinic-admin.ericgitangu.com clinic-admin --scope "$TEAM"
```

CircleCI needs no extra context: the admin jobs use `vercel-prod` (its team-scoped token can deploy both projects) and override `VERCEL_PROJECT_ID` with the admin project's id, which is not a secret and is set in `.circleci/config.yml`.
