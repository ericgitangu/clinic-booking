import type { TabContent } from "./types";

// The Operations tab: how the system is set up, released, rolled back and checked. Every command,
// name and figure was read against main (Makefile, infra/, scripts/, .circleci/, backend/, services/).

export const OPERATIONS: TabContent = {
  id: "operations",
  label: "Operations",
  intro:
    "How I set the system up, ship it, undo a release and check it. The how-tos are short and use the commands as the repo has them.",
  cards: [
    {
      id: "neon",
      title: "Neon Postgres setup",
      summary:
        "A free Neon project in aws-us-east-1 on Postgres 17, two roles, and two secrets in the right URL form.",
      blocks: [
        {
          t: "p",
          text: "The database is one free Neon project in `aws-us-east-1`, next to Cloud Run in `us-east4`, on Postgres 17 with a fixed 0.25 CU compute. Setup is the project, two roles and two Secret Manager versions. No card is needed.",
        },
        {
          t: "ol",
          items: [
            "Run `neonctl projects create --help` first and use the flags it prints. Create the project in `aws-us-east-1` on Postgres 17 with database `clinic` and owner role `clinic_owner`, and set autoscaling minimum and maximum both to 0.25 CU. `make cost-check` (check C13, when `NEON_PROJECT_ID` is set) reads the region and size back.",
            "Take the **direct** host (the one without `-pooler` in its name) and the `clinic_owner` password from the console or `neonctl connection-string`, and export them for the shell.",
            "As `clinic_owner`, create the runtime role `clinic_app` with the password on stdin. psql does not interpolate `:'pw'` inside a `-c` string, so the SQL goes in through a heredoc.",
            "Check it: connected as `clinic_app`, `CREATE TABLE x(i int)` must answer `permission denied`.",
            "Add the two secret versions. The containers (`clinic-database-url-app`, `clinic-database-url-migrate`) already exist from Terraform, which holds no values.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          caption: "Step 2: shell variables",
          code: `export NEON_HOST=ep-xxxxxxxx.us-east-1.aws.neon.tech # direct host, not -pooler
export OWNER_PW=<clinic_owner password from Neon>`,
        },
        {
          t: "code",
          lang: "bash",
          caption: "Step 3: the runtime role",
          code: `export APP_PW=$(openssl rand -hex 24) # never echo it
psql "postgresql://clinic_owner:$OWNER_PW@$NEON_HOST/clinic?sslmode=require" -v ON_ERROR_STOP=1 -v pw="$APP_PW" <<'SQL'
CREATE ROLE clinic_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL`,
        },
        {
          t: "code",
          lang: "bash",
          caption: "Step 5: the secret versions",
          code: `APP_URL="postgresql+asyncpg://clinic_app:$APP_PW@$NEON_HOST/clinic?ssl=require"
MIGRATE_URL="postgresql+asyncpg://clinic_owner:$OWNER_PW@$NEON_HOST/clinic?ssl=require"
printf %s "$APP_URL" | gcloud secrets versions add clinic-database-url-app --data-file=- --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
printf %s "$MIGRATE_URL" | gcloud secrets versions add clinic-database-url-migrate --data-file=- --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
unset APP_PW OWNER_PW APP_URL MIGRATE_URL`,
        },
        {
          t: "table",
          caption: "Two URL forms for two kinds of program",
          head: ["Used by", "Form"],
          rows: [
            [
              "`psql` (libpq)",
              "`postgresql://clinic_owner:$OWNER_PW@$NEON_HOST/clinic?sslmode=require`",
            ],
            [
              "The API and Alembic (the two secrets)",
              "`postgresql+asyncpg://USER:PASS@$NEON_HOST/clinic?ssl=require`",
            ],
            [
              "The Go gateway (its own secret)",
              "`postgres://clinic_realtime:PASS@$NEON_HOST/clinic?sslmode=require`",
            ],
          ],
        },
        {
          t: "note",
          text: "Neon hands out `postgresql://...?sslmode=require`. Pasted into an API secret it picks the psycopg driver and the first migrate fails. The settings check also rejects `sslmode` and `channel_binding` in the query, because asyncpg does not accept them. Use `ssl=require` only. If the owner password has URL-special characters, percent-encode it in the migrate URL.",
        },
        {
          t: "p",
          text: "**Rotation.** Disabled secret versions still count toward the six-version limit, so I add the new version, redeploy, then destroy the old one.",
        },
        {
          t: "code",
          lang: "bash",
          code: `gcloud secrets versions destroy <old> --secret=<secret> --account "$GCLOUD_ACCOUNT" --project "$PROJECT"`,
        },
        {
          t: "p",
          text: "**The gateway role.** The [Go service](#go-gateway) reads as `clinic_realtime`. Create the login before the release that runs migration 0014: the migration grants the role its column-level `SELECT` only if the role exists, and otherwise raises a notice and grants nothing. If the role came later, re-apply the same grants as the owner with `scripts/ops/realtime_grants.sql`.",
        },
        {
          t: "code",
          lang: "bash",
          code: `export RT_PW=$(openssl rand -hex 24)
psql "postgresql://clinic_owner:$OWNER_PW@$NEON_HOST/clinic?sslmode=require" -v ON_ERROR_STOP=1 -v pw="$RT_PW" <<'SQL'
CREATE ROLE clinic_realtime LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL
RT_URL="postgres://clinic_realtime:$RT_PW@$NEON_HOST/clinic?sslmode=require"
printf %s "$RT_URL" | gcloud secrets versions add clinic-database-url-realtime --data-file=- --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
unset RT_PW RT_URL`,
        },
      ],
    },

    {
      id: "bootstrap",
      title: "One-time GCP, CircleCI, Neon and Vercel bootstrap",
      summary:
        "Ordered steps from an empty project to the first release. CI only deploys; it creates no infrastructure.",
      blocks: [
        {
          t: "p",
          text: "This is the setup I did by hand, once. Several steps need IDs the step before produced, so the order matters. Two Google accounts are involved: the project Owner runs every IAM, Terraform and workload identity step, and a second account with billing rights runs the budget step and nothing else. My machine's active gcloud account is neither, so every `gcloud` call passes `--account`.",
        },
        {
          t: "code",
          lang: "bash",
          code: `export PROJECT=sil-clinic-booking
export GCLOUD_ACCOUNT=<project Owner account>
export BILLING_GCLOUD_ACCOUNT=<account with billing rights>
export BILLING_ACCOUNT=<shared billing account id>
export REGION=us-east4`,
        },
        {
          t: "p",
          text: "Every mode of `infra/bootstrap.sh` can be re-run and honours `DRY_RUN=1`, which prints each command and runs nothing. I dry-run first and read the output. The project sits on a billing account shared with other projects, which is why the cost is a few cents and not zero; see [hosting and cost](/decisions#hosting-and-cost).",
        },
        {
          t: "p",
          text: "**Step 0: project and billing (done).** `bash infra/bootstrap.sh project` created `sil-clinic-booking`, linked the shared billing account and enabled only the APIs Terraform needs first (serviceusage, cloudresourcemanager, storage, run). Terraform owns every other API after step 4. I do not run this mode again.",
        },
        {
          t: "p",
          text: "**Step 1: Terraform state bucket.** A versioned bucket `clinic-tfstate-sil-clinic-booking` in `us-east1` that keeps five noncurrent versions.",
        },
        {
          t: "code",
          lang: "bash",
          code: `DRY_RUN=1 PROJECT="$PROJECT" GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" bash infra/bootstrap.sh state
PROJECT="$PROJECT" GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" bash infra/bootstrap.sh state`,
        },
        {
          t: "p",
          text: "**Step 2: GitHub and CircleCI.**",
        },
        {
          t: "ol",
          items: [
            "Make sure the public repository exists and push `main`.",
            "In CircleCI, set up the project through the GitHub App and use the existing `.circleci/config.yml`.",
            "The first pipeline is expected to fail, because the contexts do not exist yet. It cannot deploy: the workload identity pool does not exist until step 4.",
            "Read the CircleCI organization id and project id from the dashboard; Terraform needs both.",
            "In Project Settings, Advanced, turn **off** Build forked pull requests and Pass secrets to builds from forked pull requests. CircleCI issues OIDC tokens to forked builds only when the second is on, and a fork that names its branch `main` would otherwise look like the real branch to the workload identity condition.",
          ],
        },
        {
          t: "p",
          text: "**Step 3: CircleCI contexts.** A job that names a missing context fails at start, so I created these before the first push to `main`. Then I copied the `gcp-deploy` context id from its page URL, because Terraform lets only jobs that use that context mint the deployer token.",
        },
        {
          t: "table",
          caption: "Contexts",
          head: ["Context", "Holds", "Restriction"],
          rows: [
            [
              "`gcp-deploy`",
              "`GOOGLE_PROJECT_ID`, `GOOGLE_PROJECT_NUMBER`, `DEPLOYER_SA`, `PUBLIC_BASE_URL`, `WEB_ORIGIN`",
              '`pipeline.git.branch == "main"`',
            ],
            [
              "`vercel-prod`",
              "`VERCEL_TOKEN` (booking project), `VERCEL_ADMIN_TOKEN` (admin project), `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`",
              '`pipeline.git.branch == "main"`',
            ],
            [
              "`ably-ci`",
              "`ABLY_API_KEY` for a throwaway CI-only Ably app",
              "none; a pull request may use it, and the key can only publish to that app",
            ],
            [
              "`oidc-probe`",
              "nothing",
              "none; used only by the negative test in step 9",
            ],
          ],
        },
        {
          t: "code",
          lang: "bash",
          code: `export GCP_DEPLOY_CONTEXT_ID=<uuid of gcp-deploy>`,
        },
        {
          t: "p",
          text: "**Step 4: Terraform.** Terraform and its `gcs` backend do not read `--account`, and `gcloud auth application-default login` takes no account flag. So I pin the identity with a short-lived access token for the Owner account and check whose it is before anything runs.",
        },
        {
          t: "code",
          lang: "bash",
          code: `export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account "$GCLOUD_ACCOUNT")
# the token lasts an hour; re-export when Terraform reports 401
curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$GOOGLE_OAUTH_ACCESS_TOKEN" | jq -r .email # must print the Owner account
cd infra/terraform
terraform init -backend-config="bucket=clinic-tfstate-$PROJECT"
cp terraform.tfvars.example terraform.tfvars # gitignored; identifiers only, no secrets
$EDITOR terraform.tfvars # project_number, circleci_org_id, circleci_project_id, circleci_gcp_deploy_context_id
terraform plan -out tfplan
bash ../plan_gate.sh tfplan
terraform apply tfplan
cd ../..`,
        },
        {
          t: "p",
          text: "`infra/plan_gate.sh` is the cost gate. It fails closed: a missing `rg`, a failing `terraform show` or an empty plan is a failure, and so is any banned resource (NAT, load balancer, Cloud SQL, Redis, VPC connector, `min_instance`, container scanning, a `europe-west` region and similar). I apply only after it prints `plan_gate: clean`. The apply also removes `roles/editor` from the default Compute service account (`default_sa.tf`); the plan should show that one binding going and nothing else, and `make cost-check` (C20) asserts it afterwards.",
        },
        {
          t: "p",
          text: "**Step 5: Cloud Run shells and invoker bindings.** This needs the service accounts from step 4.",
        },
        {
          t: "code",
          lang: "bash",
          code: `DRY_RUN=1 bash infra/bootstrap.sh service invoker
bash infra/bootstrap.sh service invoker
export RUN_APP_URL=$(gcloud run services describe clinic-api --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --region "$REGION" --format='value(status.url)')`,
        },
        {
          t: "p",
          text: "`service` creates each missing shell on Google's hello image and leaves an existing service alone: `clinic-api` (0 to 3 instances) and `clinic-realtime` in exactly the shape `ship-realtime` deploys and the cost check pins: min 0, max 2, concurrency 1, 0.25 vCPU, 256 MiB, gen1, 900 s timeout, no public access. `invoker` grants `run.invoker` to `clinic-web`, `clinic-admin` and `clinic-smoke` on the API, and to `clinic-admin` and `clinic-smoke` only on the gateway. Never `allUsers`, and never `clinic-web` on the gateway.",
        },
        {
          t: "p",
          text: "The live-feed gateway has its own run order, each step needing the one before:",
        },
        {
          t: "ol",
          items: [
            "`terraform apply` with `infra/terraform/realtime.tf` (runtime service account, the `clinic-database-url-realtime` secret container, accessors, the deployer's act-as).",
            "Create the `clinic_realtime` login on Neon and add its secret version (see [the Neon card](#neon)). It must exist before the release that runs migration 0014.",
            "`bash infra/bootstrap.sh service invoker`.",
            "Merge to `main`: `ship-api` runs migration 0014, then `ship-realtime` replaces the hello image.",
            "Set `REALTIME_URL` (the `clinic-realtime` run.app URL) on the `clinic-admin` Vercel project.",
          ],
        },
        {
          t: "p",
          text: "**Step 6: Neon.** Follow [the Neon card](#neon), including both secret versions.",
        },
        {
          t: "p",
          text: "**Step 7: Vercel.** The booking app is the project `clinic-web`, the admin app is `clinic-admin`.",
        },
        {
          t: "ol",
          items: [
            "Create the project, then in the dashboard confirm OIDC Federation is in **Team** issuer mode (a dashboard-only toggle).",
            "Set the Root Directory to `apps/booking`. The pnpm workspace keeps dependencies in the root `node_modules`, so CI builds and deploys from the repo root, not with `--cwd`. Confirm the function region is `iad1`; `apps/booking/vercel.json` pins it too.",
            "Link from the repo root and read the org and project ids from `.vercel/project.json` (gitignored).",
            "Put `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` in the `vercel-prod` context.",
            "Add the production variables. `vercel env add` prompts unless the value arrives on stdin.",
            "Write the real public URLs into `scripts/ci/public-urls.env` (`WEB`, `ADMIN`, `RUN_APP_URL`) and commit it **before the first push to `main`**. `smoke-public` fails fast while a placeholder remains, so skipping this turns the first release red at its last job. Put `PUBLIC_BASE_URL` (the web origin plus `/api`) and `WEB_ORIGIN` in the `gcp-deploy` context.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          code: `export TEAM=eric-gitangus-projects
vercel project add clinic-web --scope "$TEAM"
vercel link --yes --project clinic-web --scope "$TEAM" # from the repo root
addenv() { printf %s "$2" | vercel env add "$1" production --scope "$TEAM"; }
addenv API_URL "$RUN_APP_URL"
addenv API_AUDIENCE clinic-api
addenv GCP_PROJECT_NUMBER "$PROJECT_NUMBER"
addenv GCP_SERVICE_ACCOUNT_EMAIL "clinic-web@$PROJECT.iam.gserviceaccount.com"
addenv GCP_WORKLOAD_IDENTITY_POOL_ID vercel
addenv GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID vercel
addenv RATE_LIMIT_PER_MINUTE 120`,
        },
        {
          t: "p",
          text: "Those are the identity variables. The sign-in, signing-key and mail variables are sensitive and are set the same way with `--sensitive`. Before each web deploy, `scripts/ci/vercel_env_check.sh` lists the names (never the values) of the project's production variables and refuses to ship if any name in `scripts/ci/required_env.txt` is missing: 13 for the booking app, 12 for the admin app.",
        },
        {
          t: "p",
          text: "**Step 8: spend cap, before the first push to `main`.** The budgets have their own Terraform root, `infra/billing`, because creating them needs billing rights on the shared account, which only the second account has. It creates `clinic-alerts-1usd`, an alert on this project's gross spend. Neither Terraform nor the CLI can express a spend cap, so `clinic-run-spend-cap-3usd` (a $3 gross budget for this project and Cloud Run, thresholds 0.5, 0.8 and 1.0) is created in the console as a Spend cap enforcement budget. An existing budget cannot be converted, so I deleted the alerts-only version of it first.",
        },
        {
          t: "code",
          lang: "bash",
          code: `export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account "$BILLING_GCLOUD_ACCOUNT")
curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$GOOGLE_OAUTH_ACCESS_TOKEN" | jq -r .email # must print the billing account's email
cd infra/billing
terraform init -backend-config="bucket=clinic-tfstate-$PROJECT"
cp terraform.tfvars.example terraform.tfvars
terraform plan -out tfplan && bash ../plan_gate.sh tfplan
terraform apply tfplan
cd ../..
gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --account "$BILLING_GCLOUD_ACCOUNT" --billing-project "$PROJECT" --format='value(displayName)' # both names`,
        },
        {
          t: "p",
          text: "**Step 9: first release.** I push to `main`. The release workflow runs the verify jobs, builds and scans the image, migrates, deploys a tagged no-traffic revision, smokes it, promotes it, ships the two web apps and runs the public smoke. If the URLs from step 7 are wrong, `smoke-public` is the job that goes red. These checks need the real accounts, so I did them on the first release in this order:",
        },
        {
          t: "table",
          caption: "First-deploy checks",
          head: ["Check", "How", "Expected"],
          rows: [
            [
              "Vercel OIDC reaches Cloud Run",
              "`curl -s -o /dev/null -w '%{http_code}' \"$WEB/api/health\"`",
              "`200`. A `502` with `UPSTREAM_AUTH_FAILED` means read `vercel logs`; the proxy logs the STS or IAM status.",
            ],
            [
              "Cloud Run is IAM-only",
              "`curl -s -o /dev/null -w '%{http_code}' \"$RUN_APP_URL/health\"`",
              "`403`. Any `200`: stop and look for `allUsers` on `run.invoker`.",
            ],
            [
              "Workload identity accepts only the deploy context",
              "push the branch `test/wif-deny`; it runs a job on the empty `oidc-probe` context",
              "the token exchange is refused",
            ],
            [
              "Workload identity accepts the deploy job",
              "the first `ship-api` run",
              "a green login step",
            ],
            [
              "Registry prune",
              "the `cost-check` job after a few releases",
              "every package at 2 versions or fewer",
            ],
            [
              "Billing report",
              "Billing, Reports, grouped by SKU, 48 hours after the first release",
              "every SKU at $0.00 after savings",
            ],
          ],
        },
        {
          t: "code",
          lang: "bash",
          caption:
            "The read-only live cost guards, run by hand because the billing checks need the billing account",
          code: `GCLOUD_ACCOUNT="$GCLOUD_ACCOUNT" BILLING_GCLOUD_ACCOUNT="$BILLING_GCLOUD_ACCOUNT" PROJECT="$PROJECT" BILLING_ACCOUNT="$BILLING_ACCOUNT" make cost-check`,
        },
        {
          t: "p",
          text: "**reCAPTCHA key.** Terraform enables the API and creates the `clinic-recaptcha` service account first. I then create a score-based web key and keep the key id: it is public by design. A release builds without Vercel credentials, so the key id for the production build lives in `scripts/ci/public-build.env`; locally it goes in the gitignored `apps/booking/.env.local`. There is no secret, because the booking server calls reCAPTCHA through the Vercel identity.",
        },
        {
          t: "code",
          lang: "bash",
          code: `gcloud recaptcha keys create --web --integration-type=score --domains=clinic.ericgitangu.com,localhost --display-name=clinic-web --account "$GCLOUD_ACCOUNT" --project "$PROJECT"
gcloud recaptcha keys list --account "$GCLOUD_ACCOUNT" --project "$PROJECT"`,
        },
        {
          t: "p",
          text: "**Admin app.** A second Vercel project, `clinic-admin`, with its own service account (created by `infra/terraform`). The OIDC provider admits exactly the `clinic-web` and `clinic-admin` production subjects. CircleCI needs no extra context: the admin jobs use `vercel-prod` with the admin token and override `VERCEL_PROJECT_ID`, which is an identifier and sits in `.circleci/config.yml`.",
        },
        {
          t: "code",
          lang: "bash",
          code: `vercel project add clinic-admin --scope "$TEAM"
vercel api -X PATCH "/v9/projects/clinic-admin?teamId=$VERCEL_ORG_ID" -f rootDirectory=apps/admin -f framework=nextjs
vercel domains add clinic-admin.ericgitangu.com clinic-admin --scope "$TEAM"`,
        },
        {
          t: "note",
          text: "Do not reorder the steps and do not re-run `project`. The one risk I accepted at the end: the deployer can act as the migrate and runtime service accounts and holds a project-wide `run.developer`, so any job that can mint the deployer token can run an arbitrary command under the migrate identity. The workload identity condition (this project, this repository, `main`, the `gcp-deploy` context) is the control, which is why the contexts are restricted to `main` and fork builds are off. Scoping `run.developer` to the individual service and job is the next tightening. Rate limiting on the Vercel proxy is per warm instance, so it bounds one client, not a distributed one.",
        },
      ],
    },

    {
      id: "base-image-cve",
      title: "Base-image CVE",
      summary:
        "When Trivy fails the image scan on the base image: rebuild on the newest digest, then a dated ignore.",
      blocks: [
        {
          t: "p",
          text: "The API image builds on `python:3.12-slim`, pinned by digest. When the Trivy scan fails on a HIGH or CRITICAL in that base image and not in our own dependencies, I work through these steps.",
        },
        {
          t: "ol",
          items: [
            "Re-resolve the current digest of `python:3.12-slim`.",
            "Put the new digest on both `FROM python:3.12-slim@sha256:...` lines in `backend/Dockerfile` (the builder and the runtime stage), note the digest and date in the comment above them, then rebuild and scan again with the same flags CI uses.",
            "Only if the newest digest still carries the CVE: add a line to `.trivyignore` that says why it cannot be exploited here and expires within 30 days.",
            "When the expiry date passes, remove the line and scan again. The CVE has to be fixed upstream or justified again.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          caption: "Steps 1 and 2",
          code: `docker buildx imagetools inspect python:3.12-slim | rg '^Digest:'
docker buildx build --provenance=false --sbom=false --load -t clinic-api:ci backend
trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 clinic-api:ci`,
        },
        {
          t: "code",
          lang: "text",
          caption: "Step 3: the .trivyignore format",
          code: `CVE-XXXX-YYYY # no fix in debian bookworm yet; not reachable from our code path; expires 2026-11-15`,
        },
        {
          t: "p",
          text: "The scan runs in `build-scan` on every branch, again in `build-scan-push` before the image is pushed, and for the gateway image in `build-scan-push-realtime`. It fails only on vulnerabilities that already have a fix (`--ignore-unfixed`). Scanning stays in CI: the Google Artifact Analysis and container-scanning APIs stay disabled so deploys stay keyless and free, and `infra/plan_gate.sh` bans them (see [hosting and cost](/decisions#hosting-and-cost)). After feature freeze I keep the base digest frozen, and only a CVE that blocks a release justifies a new one.",
        },
        {
          t: "note",
          text: "Nothing reads the expiry date in `.trivyignore`. The 30-day limit is my rule, enforced by me removing the line, not by a check. The file is empty today.",
        },
      ],
    },

    {
      id: "rollback",
      title: "Rollback",
      summary:
        "A release is a tagged revision, so rollback is a traffic move, done for me when the public check fails.",
      blocks: [
        {
          t: "p",
          text: "`ship-api` deploys with `--no-traffic --tag sha-<7>`, smokes the tag URL, then moves 100% of traffic to it. The previous revision keeps its tag, and the registry keeps the newest two images, so going back is a traffic move and not a rebuild. I list the tags, send traffic to the previous one and check.",
        },
        {
          t: "code",
          lang: "bash",
          code: `export PROJECT=sil-clinic-booking
export GCLOUD_ACCOUNT=<account with access to the project>
export WEB=https://clinic.ericgitangu.com # the admin app is https://clinic-admin.ericgitangu.com
export PUBLIC_API="$WEB/api"`,
        },
        {
          t: "ol",
          items: [
            "List the revisions with their tags and traffic.",
            "Send 100% back to the previous tag.",
            "Check that the API answers and the live claims hold. `--read-only` sends GETs only, so the check creates no patient.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          code: `gcloud run services describe clinic-api --region us-east4 --project "$PROJECT" --account "$GCLOUD_ACCOUNT" --format=json | jq -r '.status.traffic[] | [.tag, .percent, .revisionName] | @tsv'
gcloud run services update-traffic clinic-api --region us-east4 --project "$PROJECT" --account "$GCLOUD_ACCOUNT" --to-tags "sha-<previous>=100"
curl -fsS "$PUBLIC_API/ready"
python3 scripts/verify_claims.py --base-url "$PUBLIC_API" --read-only`,
        },
        {
          t: "p",
          text: "I never use `--to-latest`. The release keeps exactly two rollback candidates, the revision that is live and the one before it. A release skipped because a newer commit landed is not a candidate and is pruned.",
        },
        {
          t: "p",
          text: "**Web.** Vercel keeps earlier production deployments for each app (`clinic-web` is the booking app, `clinic-admin` the admin app). In the dashboard I pick the last good deployment and choose Promote to Production, or run `vercel rollback --scope <team>`. If the web build shipped a contract the old API lacks, the API goes back first and the web second, so the two never disagree.",
        },
        {
          t: "p",
          text: "**Database.** Migrations are expand-only (`scripts/migration_lint.sh` enforces it) and the app role has no DDL rights, so old code runs against the newer schema and a rollback never needs a schema change. I do not run `alembic downgrade` against production. A bad data change is fixed forward with a new migration. A bad base image is handled in [the CVE card](#base-image-cve), then a new release.",
        },
        {
          t: "p",
          text: "**Automatic rollback.** After `ship-booking` and `ship-admin`, `verify-release` runs `scripts/ci/public_smoke.sh`: `/ready` through the public URL and a read-only pass of `verify_claims.py`, retried for about 90 seconds to ride out cold starts. If it still fails, these run in order:",
        },
        {
          t: "ul",
          items: [
            "`rollback-api` runs `scripts/ci/rollback.sh`, and `rollback-realtime` does the same for the gateway if this release promoted it.",
            "`rollback-booking` and `rollback-admin` point production at the previous deployment of each app by id (`scripts/ci/vercel_prod.sh rollback <id>`). They run only if the API went back first.",
            "`smoke-public` fails on purpose, so a rolled-back release stays red.",
          ],
        },
        {
          t: "p",
          text: "`rollback.sh` reads `keep.json` from `promote.sh` and refuses with exit 2 when there is no previous revision, when the previous one is not an image from this project's `clinic` registry (the hello placeholder would take the API down), or when production is no longer on the revision this release promoted. If it refuses, the web rollback does not run and the pipeline fails loudly. `vercel rollback` switches off automatic alias assignment, so `ship-booking` and `ship-admin` record the live deployment first and, after every deploy, check that the public alias serves the new one and promote it if not. `.circleci/rollback.yml` is the manual one-click version for the CircleCI Deploys UI. Its API job goes to a tag it is given, through `rollback.sh --to-tag`, which checks the tag exists. Its web job always goes to the previous production deployment, because Vercel deployments are not tagged with the release.",
        },
        {
          t: "p",
          text: "**Kill switch.** If the daily egress alert fires, `bash scripts/ops/kill_switch.sh` is a dry run that prints which `roles/run.invoker` bindings it would remove from `clinic-api` and `clinic-realtime`. With `--apply` it records the prior policy to `~/.clinic-kill-switch/state.json` first, then removes the `clinic-web` and `clinic-admin` bindings, so every request becomes an unbilled IAM denial (`clinic-smoke` is left alone). `--restore --apply` re-adds exactly what it removed. It acts only on `sil-clinic-booking` in `us-east4`.",
        },
        {
          t: "code",
          lang: "bash",
          code: `bash scripts/ops/kill_switch.sh
bash scripts/ops/kill_switch.sh --apply
bash scripts/ops/kill_switch.sh --restore --apply`,
        },
        {
          t: "p",
          text: "**Vercel tokens.** The `vercel-prod` context holds one token per project: `VERCEL_TOKEN` for `clinic-web` and `VERCEL_ADMIN_TOKEN` for `clinic-admin`. `scripts/ci/select_vercel_token.sh` hands each job its own. If a step stops with a 403, the token is not scoped to that job's project; I create a new team-scoped token and update the context. If an admin job says `VERCEL_ADMIN_TOKEN` is not set, nothing was deployed or rolled back. A web app missing a required variable is caught earlier by `scripts/ci/vercel_env_check.sh`; if one slips through, sign-in answers a 503 page and logs `auth_not_configured` with the missing names, and the fix is to add them in Vercel and redeploy, with no rollback.",
        },
        {
          t: "p",
          text: "**Switching staff CRUD off.** Before I set `STAFF_CRUD_ENABLED=false`, I unlock any staff-locked visit while the unlock route still works. Once the switch is off that route answers 404 and a locked visit stays locked for the patient (`APPOINTMENT_LOCKED`). If it is already off, I clear the lock as the owner role, in one transaction, counting first. Only the lock column changes; `staff_action_audit` is untouched, so the veto stays on record.",
        },
        {
          t: "code",
          lang: "sql",
          code: `SELECT count(*) FROM appointments WHERE staff_locked_at IS NOT NULL;

BEGIN;
UPDATE appointments SET staff_locked_at = NULL WHERE staff_locked_at IS NOT NULL;
-- the reported row count must equal the number counted above; otherwise ROLLBACK
COMMIT;`,
        },
        {
          t: "note",
          text: "The automatic rollback is built and its scripts are tested against fakes (`make ci-test`), but as of 2026-10-20 I have not seen it move production traffic back: every release I read passed the public check, so the rollback jobs halted with nothing to do.",
        },
      ],
    },

    {
      id: "go-gateway",
      title: "Why a Go service sits beside FastAPI",
      summary:
        "A read-only Go service streams the staff live feed so patient names stay inside Google Cloud.",
      blocks: [
        {
          t: "p",
          text: "`services/realtime` is a small Go service on Cloud Run (`clinic-realtime`) that streams the booking log to the staff dashboard over server-sent events. It only reads. Its database role can select a few columns and nothing else, and every write still goes through FastAPI, so the booking rules and the double-booking guarantee stay in one codebase with one test suite. The short version is on [the Go decision](/decisions#go); this card is what backs each claim.",
        },
        {
          t: "ul",
          items: [
            "**Why not Ably for staff too.** Patient events say only that a time was taken or freed, with no personal fields, so a third-party pub/sub is fine for them. Staff events carry the patient's name and a cancellation reason. That is health-adjacent data, so it stays inside Google Cloud: Go reads Postgres and streams to the admin app behind IAM.",
            "**Why a separate service.** Open streams can never use up the API's capacity and slow down booking. Go gives a small image and a fast cold start, which matter on a service that scales to zero.",
            "**What it costs.** A second runtime to build, scan and deploy (the `go-quality` job, an image scan, a 25 MB image cap, and a `ship-realtime` job with a smoke test and rollback). Below 1 vCPU Cloud Run allows one request per instance, so the service runs at concurrency 1, 0 to 2 instances, and two staff can watch live at once. A third sees a busy notice and the page refreshes every 30 seconds.",
            "**Cost figure.** One connected hour at 0.25 vCPU is about 900 vCPU-seconds. That is deduced (0.25 x 3,600), not measured. `scripts/ops/measure_realtime_cost.sh` measures it on the deployed service and fails above 1,100.",
            "**History.** I first designed the gateway, a later plan moved everything to Ably and marked the gateway superseded without my sign-off, and on 2026-10-19 I reversed that because the staff view needs names.",
            "**Revisit when** more than two staff need the live view at once, or there is more than one clinic. Then fan-out moves to Pub/Sub or Redis inside Google Cloud, so a viewer no longer holds an instance.",
          ],
        },
        {
          t: "table",
          caption: "Each claim and where it is checked",
          head: ["Claim", "Checked by"],
          rows: [
            [
              "Every write stays in FastAPI",
              "Migration `0014_realtime_reader_role` grants `SELECT` on listed columns only. `backend/tests/integration/test_realtime_role.py` logs in as `clinic_realtime` and expects SQLSTATE 42501 for writes, DDL and anything outside the grant. `services/realtime/internal/store/readonly_test.go` fails if Go code sends a non-SELECT statement.",
            ],
            [
              "Patient events carry no personal data",
              "`SlotEvent` in `backend/app/schemas/events.py` forbids extra fields; `contracts/events/slot-event.v1.schema.json`; a banned-name check in `backend/tests/unit/test_realtime_domain.py`.",
            ],
            [
              "Staff events carry names, viewers do not",
              "`contracts/events/staff-event.v1.schema.json` against `admin-event.v1.schema.json`. Shared examples are checked in Python (`test_event_examples.py`) and Go (`events_test.go`); the wire is checked in `gateway/stream_test.go` and in the browser by `apps/admin/e2e/live-feed.spec.ts`.",
            ],
            [
              "Streams are IAM-only and need the signed staff assertion",
              "`gateway/auth_test.go`, assertion vectors signed by Python in `contracts/assertion-vectors.json`, and invoker members pinned by `scripts/cost_check.sh` (C2) to the admin app and the smoke identity.",
            ],
            [
              "0 to 2 instances, back to zero",
              "The deploy line in `.circleci/config.yml`, pinned by `cost_check.sh --static` and live check C1 (max exactly 2, min 0).",
            ],
            [
              "Streams close at 290 seconds",
              "`MAX_CONNECTION` in `services/realtime/internal/config/config.go`, tested in `lifecycle_test.go`. Vercel Hobby caps a function at 300 seconds.",
            ],
            [
              "A third viewer sees the busy notice",
              "`apps/admin/e2e/live-feed.spec.ts` and `apps/admin/tests/live-stream.test.ts`.",
            ],
          ],
        },
        {
          t: "note",
          text: "Not yet measured: the real cost of a connected hour. The 900 vCPU-second figure is arithmetic from the instance size.",
        },
      ],
    },

    {
      id: "admin-access",
      title: "Admin app access",
      summary:
        "Who may open the dashboard, the variables behind sign-in, and how I grant, revoke and rotate.",
      blocks: [
        {
          t: "p",
          text: "The admin app (`apps/admin`, Vercel project `clinic-admin`, host `clinic-admin.ericgitangu.com`) shows the clinic dashboard. Access is by role, `owner`, `admin` or `viewer`, and the API checks the role on every request ([thin web layer](/decisions#thin-web-layer)). The owner is the address in `ADMIN_EMAILS`; everyone else is added by the owner on the Access page.",
        },
        {
          t: "table",
          caption:
            "Vercel project clinic-admin, Production. Sensitive values are set with `vercel env add NAME production --sensitive` and never written to a file.",
          head: ["Name", "Sensitive", "What it is"],
          rows: [
            [
              "`BETTER_AUTH_SECRET`",
              "yes",
              "Signs and encrypts the session cookie. 32 or more random characters.",
            ],
            [
              "`BETTER_AUTH_URL`",
              "no",
              "The app's own origin, `https://clinic-admin.ericgitangu.com`.",
            ],
            [
              "`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`",
              "the secret: yes",
              "The Google OAuth client. Its redirect URI is `<BETTER_AUTH_URL>/auth/callback/google`.",
            ],
            [
              "`ADMIN_EMAILS`",
              "no",
              "The owner's address. Comma separated for more than one owner.",
            ],
            [
              "`INTERNAL_SIGNING_KEY`",
              "yes",
              "Signs the app-to-API assertion. 32 or more characters, the same value as on the API.",
            ],
            [
              "`API_URL`, `API_AUDIENCE`",
              "no",
              "The Cloud Run URL of `clinic-api` and its audience.",
            ],
            [
              "`GCP_PROJECT_NUMBER`, `GCP_SERVICE_ACCOUNT_EMAIL`, `GCP_WORKLOAD_IDENTITY_POOL_ID`, `GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID`",
              "no",
              "Identity federation to Cloud Run, as for the booking app, with the `clinic-admin` service account.",
            ],
          ],
        },
        {
          t: "p",
          text: "On the API side, `ship-api` passes `INTERNAL_SIGNING_KEY` from the Secret Manager secret `clinic-internal-signing-key` and sets `ADMIN_EMAILS` from one place in `.circleci/config.yml` (the `owner_emails` command), which the gateway uses too, so the two always agree. Without the signing key every `/internal/*` call is refused. Migration `0003` needs a role that may run `CREATE EXTENSION citext`.",
        },
        {
          t: "p",
          text: "**Live check, once after the first deploy.** No automated test can do this, because it uses Google itself.",
        },
        {
          t: "ol",
          items: [
            "Open the admin URL in a private window. The sign-in page shows.",
            "Choose Sign in with Google with the owner account. I land on the dashboard and the bar shows the Owner role.",
            "Open Access. The owner row says it is fixed by configuration.",
            "Sign out, then sign in with any other Google account. The page says I do not have access (a 403) and nothing from the dashboard shows.",
            "As the owner, add that second account as Viewer, reload as that account and confirm the dashboard opens with no Access link. Revoke it and confirm the next click is refused.",
          ],
        },
        {
          t: "p",
          text: "**Granting and revoking** happens on the Access page: add an email with a role, change a role, or revoke. A revoke applies on the person's next click. Every change is a row in `staff_access_audit`:",
        },
        {
          t: "code",
          lang: "sql",
          code: `SELECT occurred_at, actor_email, action, target_email, old_role, new_role
FROM staff_access_audit ORDER BY occurred_at DESC LIMIT 20;`,
        },
        {
          t: "p",
          text: "**Rotating the signing key.** Add a new version of `clinic-internal-signing-key`, update `INTERNAL_SIGNING_KEY` in both Vercel projects, redeploy the API, the gateway and both apps, then destroy the old secret version. Calls fail for a few minutes in between, which I accept.",
        },
        {
          t: "p",
          text: "**End-to-end suite.** `make e2e-admin` starts the compose API and Postgres with throwaway secrets, builds the app and runs Playwright against them. Everything is real except Google's sign-in.",
        },
        {
          t: "note",
          text: "If the sign-in step fails with a redirect error, the redirect URI in the Google client does not match `BETTER_AUTH_URL`.",
        },
      ],
    },

    {
      id: "notifications",
      title: "Notifications",
      summary:
        "How the dashboard tells staff something happened, and why doctors are told only there.",
      blocks: [
        {
          t: "p",
          text: "Arrivals, no-shows, bookings, changes and vetoes already reach the admin dashboard through the one live stream. The feed panel is easy to miss, so the same events now raise a toast, add to an unread count on the feed heading, and outline the doctor's card on the today board for two seconds.",
        },
        {
          t: "ul",
          items: [
            "**Only what happens after the page opens.** When a connection resumes from a cursor, the gateway replays what was missed and sends no marker between the replay and live events. The client treats frames that follow the hello with less than 1.5 s between them as the replay (the gateway polls every second) and does not announce them. A real event inside that window is not toasted, though it still appears in the feed.",
            "**One stream.** The toasts listen to the stream the browser already shares between tabs. They open no connection of their own, so the gateway's two-stream capacity is untouched.",
            '**Bursts.** Up to three events in two seconds are three toasts; a fourth replaces them with one "4 updates" toast that keeps counting. Nothing is held back to decide.',
            "**Viewers.** A viewer's events carry no patient or staff name, and a viewer's message that does carry one is refused whole. The toast text is built from that minimised shape, so there is nothing to leak.",
            '**No sound, no colour-only cue.** The unread count is words in a polite live region with a fixed box, so the table does not move. The doctor card gets an outline and the word "Updated"; with reduced motion the outline stays still for the same two seconds.',
          ],
        },
        {
          t: "note",
          text: "Doctors have no accounts and no email address on file, so they are notified only through the dashboard. The fix is a `doctors.email` column linked to `staff_access`, a Resend notification, and a morning digest, all inside the 100 a day cap the booking emails share.",
        },
      ],
    },

    {
      id: "demo-seed",
      title: "Demo seed",
      summary:
        "A hand-run script that fills the clinic with invented patients and four weeks of bookings for the dashboard.",
      blocks: [
        {
          t: "p",
          text: "`python -m app.scripts.seed_demo` adds invented patients and four weeks of bookings so the admin dashboard has believable activity to review. I run it by hand, once, after the core seed. It is not part of the release migrate job and never runs on a deploy.",
        },
        {
          t: "ol",
          items: [
            "Run the core seed first. It is already in production, applied by the release migrate job.",
            "Run the demo seed with the same database connection string the core seed uses, from `backend`. `--today YYYY-MM-DD` fixes the date; without it the date is the current Nairobi date, or yesterday before 07:00 there.",
            "It prints the counts it inserted.",
          ],
        },
        {
          t: "code",
          lang: "bash",
          code: `cd backend
DATABASE_URL=... uv run python -m app.scripts.seed
DATABASE_URL=... uv run python -m app.scripts.seed_demo [--today YYYY-MM-DD]`,
        },
        {
          t: "facts",
          items: [
            {
              label: "Patients",
              value:
                "100 with `demo = true`: about 40 hand-written and 58 built from the same community tables, paired by community and gender across children, teens, adults and seniors. The names are AI-generated and fictional.",
            },
            {
              label: "Contact details",
              value:
                "Emails end in `@example.com`, which is reserved for documentation, so no message can reach anyone. Phones run from `+254700000001` to `+254700000100`.",
            },
            {
              label: "Appointments",
              value:
                "All five seeded doctors, 14 days before `--today` to 14 days after, inside working hours on the 30-minute grid. Booked share per doctor is 47 to 66 percent, about 10 percent of all appointments are cancelled with plain reasons, and about 9 percent of booked visits were moved.",
            },
            {
              label: "Past visits",
              value:
                "Marked at the desk the way the app does it: an attendance row (about 5 percent no-show), a staff audit row and an `arrived` or `no_show` event, all under the fictional label `reception@example.com`, which is not in `staff_access` and opens nothing.",
            },
            {
              label: "Events",
              value:
                "Backdated at least an hour, beyond the realtime relay's freshness window, so the seed never pushes anything to the live feed.",
            },
          ],
        },
        {
          t: "p",
          text: "**Idempotent.** Ids are `uuid5` of stable keys and every choice is a hash of them, so a second run with the same `--today` inserts nothing. A later date adds the new days and never changes or deletes a row. A slot already held by a real booking is skipped, not displaced. The schema has no locality column; the Nairobi area names only decide which cancellation reasons suit a person.",
        },
        {
          t: "p",
          text: "**Demo is not synthetic.** `patients.demo` marks these people as invented, and they appear in every admin view. `patients.synthetic` is the release smoke's flag and is left out of every admin view. The two are separate on purpose.",
        },
        {
          t: "note",
          text: "Nothing removes the demo rows automatically, and I have not run a removal. A manual one has to delete the event, attendance and audit rows that reference those appointments before the appointments and then the patients, as the owner role in one transaction.",
        },
      ],
    },

    {
      id: "third-party",
      title: "Third-party services and material",
      summary:
        "What each outside service is used for, the free-tier bound I rely on, and the licence of the borrowed art.",
      blocks: [
        {
          t: "p",
          text: "Everything runs on free plans with no card on file except Google Cloud, which sits on a shared billing account. The limits below are the ones the code or config enforces, not the vendor's marketing page. The total bill is about $0.35 a month on the shared account, under a $0.50 ceiling I set.",
        },
        {
          t: "table",
          caption: "Services",
          head: ["Service", "Used for", "Limit or bound"],
          rows: [
            [
              "Vercel (Hobby)",
              "The booking and admin apps, the API proxy and a daily reminder cron at 15:00 UTC.",
              "Functions pinned to `iad1`. A function is capped at 300 seconds, so streams close at 290.",
            ],
            [
              "Google Cloud",
              "Cloud Run for the API and the gateway, a Cloud Run job for migrations, Artifact Registry, Secret Manager, a Cloud Storage bucket for Terraform state, workload identity federation, reCAPTCHA Enterprise.",
              "API 0 to 3 instances, gateway 0 to 2. Two images kept per service. At most six active secret versions. A $1 alert budget and a $3 Cloud Run spend cap. See [hosting and cost](/decisions#hosting-and-cost).",
            ],
            [
              "Neon (Free)",
              "Postgres 17 in `aws-us-east-1`.",
              "Fixed 0.25 CU compute. [Setup](#neon).",
            ],
            [
              "CircleCI (free plan)",
              "Every check and the release pipeline.",
              "Only `small` and `medium` resource classes, no Docker layer caching. Images are pulled through `mirror.gcr.io`.",
            ],
            [
              "Ably (free package)",
              "Pushing taken and freed slots to the patient booking page. Staff events do not go through it.",
              "No payment method. The API enforces a ceiling of 25,000 publishes a month: 25,000 x (1 + 200 connections) is 5,025,000, under the 6,000,000 messages of the free package.",
            ],
            [
              "Resend",
              "Booking, cancellation and daily reminder emails, sent from `reminders@mail.ericgitangu.com`, the verified subdomain.",
              "100 sends a day and 3,000 a month, reserved in the database before each send. Reminders go only to verified linked accounts.",
            ],
            [
              "Google sign-in",
              "Patient and staff sign-in through Better Auth.",
              "OAuth client created by me; no secret in the repository.",
            ],
            [
              "Hugging Face",
              "Generating the doctor portraits, through the Space `mcp-tools/Z-Image-Turbo`.",
              "Used once, by hand (`make avatars`); not called at runtime.",
            ],
          ],
        },
        {
          t: "table",
          caption: "Borrowed material",
          head: ["Material", "Where", "Licence"],
          rows: [
            [
              "Doctor portraits: AI-generated pictures of fictional doctors, made with Z-Image-Turbo (`Tongyi-MAI/Z-Image-Turbo`)",
              "`packages/ui/assets/doctors/*.webp`",
              "Apache 2.0, from the model card. It allows commercial use and does not restrict outputs. That is my reading of the published licence, not legal advice.",
            ],
            [
              "Fallback avatars: Lorelei by Lisa Wischofsky, via DiceBear",
              "`packages/ui/assets/doctors/`",
              "CC0 1.0",
            ],
          ],
        },
        {
          t: "p",
          text: "The portraits are disclosed as AI-generated on the doctor list, in the footer and in each image's description. The model, settings, prompt and derivatives are recorded in the assets README next to the images.",
        },
      ],
    },

    {
      id: "verification",
      title: "How things are verified",
      summary:
        "Six layers of checks, from git hooks to post-deploy scans, and what each one runs against.",
      blocks: [
        {
          t: "p",
          text: "Two rules shape all of it. Our own code is never mocked: every test that touches the API or the database uses a real Postgres and a real HTTP stack, and only third parties are stood in, each labelled. And a test I have not seen fail proves little, so the race suite carries a naive control that must double-book, and I mutation-check the guards that matter.",
        },
        {
          t: "table",
          caption: "The layers",
          head: ["Layer", "Runs", "What it checks"],
          rows: [
            [
              "Git hooks",
              "On my machine, at commit and push",
              "`gitleaks` on staged files and `lint-staged` at commit; `commitlint` on the message; at push, `gitleaks` over the pushed commits, then `make lint lint-go hygiene test-unit`.",
            ],
            [
              "Static and unit",
              "CircleCI, every branch and `main`",
              "`lint`, `backend-quality`, `backend-test`, `backend-contract`, `go-quality`, `web-quality`.",
            ],
            [
              "Security",
              "CircleCI, every branch and `main`",
              "`secrets`, `sast`, `sca`, `build-scan`, `cost-static`, and `dast` on pull requests only.",
            ],
            [
              "Real-stack end to end",
              "CircleCI, every branch and `main`",
              "`e2e-real`, `admin-e2e`, `api-check`, `ably-real`.",
            ],
            [
              "Release gates",
              "CircleCI, `main` only",
              "Image scan before push, migrate, tag-URL smoke, promote only if still head of `main`, web environment check, public smoke, automatic rollback, production ZAP baseline, live cost check.",
            ],
            [
              "By hand",
              "My machine",
              "`make cost-check` with billing rights, `make e2e`, `make e2e-admin`, `make api-check`, the `test/wif-deny` branch.",
            ],
          ],
        },
        {
          t: "p",
          text: "**Static and unit, in detail.**",
        },
        {
          t: "ul",
          items: [
            "`lint` runs `make lint` (markdownlint, ESLint and `tsc` across the workspace, `ruff`, `mypy --strict`) and `make hygiene`, then regenerates the API client from `contracts/openapi.json` and fails on any diff.",
            "`backend-quality` runs the expand-only migration lint, requires a single Alembic head, and fails if `contracts/openapi.json` is stale.",
            "`backend-test` runs unit, integration and migration tests on Postgres 17 with coverage at or above 85 percent, then holds the pure domain to 95 percent from unit tests alone, then runs the race and control suites.",
            "`backend-contract` runs Schemathesis against the API.",
            "`go-quality` runs `gofmt`, `go vet`, `staticcheck`, `golangci-lint`, `gosec`, `govulncheck`, then `go test -race` against a real database and the real API.",
            "`web-quality` runs `pnpm audit` at high severity, the unit tests, both builds, and a smoke that starts each app with no sign-in settings and requires a 503, never a 500.",
          ],
        },
        {
          t: "p",
          text: "**Security and cost.** `secrets` is `gitleaks` over the full history. `sast` is `semgrep` (Python, TypeScript, OWASP top ten). `sca` is `pip-audit` over the locked dependencies. `build-scan` builds the image and runs Trivy on the image and on `backend/Dockerfile` and `infra/`. `dast` is the ZAP API scan against the compose stack; on `main` it is replaced by a passive ZAP baseline against the live site (`zap-prod`). `cost-static` runs `scripts/cost_check.sh --static`, the CI script tests and a self-test that proves every banned flag by mutation.",
        },
        {
          t: "p",
          text: "**Real-stack end to end.** `e2e-real` brings up the API and Postgres with docker compose (migrations and seed included), runs the generated client against it, runs the booking Playwright scenarios on a production build, then Lighthouse on `/`, `/book`, `/about` and `/data`, then rebuilds the app the way the release does and checks reCAPTCHA loads with the production site key. `admin-e2e` does the same for the admin app with the gateway running; only Google's sign-in is replaced. `api-check` runs the reviewer's Postman collection with newman. `ably-real` talks to the real push service on a CI-only Ably app and fails if any test is skipped.",
        },
        {
          t: "p",
          text: "**Release gates.** `ship-api` migrates through a Cloud Run job, deploys a tagged revision with no traffic and runs `scripts/verify_claims.py` against the tag URL with a signing key, so its test patients are marked synthetic. It promotes only if the commit is still the head of `main`, then prunes old revisions. The web apps deploy only if the API was promoted. `verify-release` and `smoke-public` run with no credentials, and `smoke-public` also proves the direct run.app URL answers 403 anonymously. `cost-check` then runs the live guards read-only.",
        },
        {
          t: "p",
          text: "**Proofs that a test can fail.** Mutation checks are done by hand and then restored. The recorded ones: dropping a path from a route matcher fails a named test; a fresh idempotency key per call fails the double-submit end-to-end test; using the first clinic's time zone fails the cancel-zone tests; removing a test file fails the domain coverage gate; echoing part of an unreadable response body fails the leak tests; seven mutations in the relay and budget code each fail a named test; and the same barrier against a database without the unique index must book more than once.",
        },
        {
          t: "p",
          text: "**What review caught.** Each pull request was read by a separate review session that ran its own checks against a real stack before merge. Examples recorded in the pull request threads: internal `/internal/*` paths exposed in the public spec; an account link keyed on a per-process user id that created two patients for one Google person on two instances; a deadlock between two counter locks in the email budget, found on real Postgres and fixed by one lock order; and an end-to-end flake whose root cause was a wait that passed on the old URL.",
        },
        {
          t: "p",
          text: "**Observed live.** On 2026-10-18 a test booking through the real UI, with reCAPTCHA passing, produced booking and cancellation emails that Resend showed as delivered and that reached the inbox from the verified sender. The first send of the daily reminder was still unconfirmed then. The release pipeline's own earlier test rows were marked `synthetic` by migration 0012, so they are excluded from every admin view and nothing was deleted.",
        },
        {
          t: "ul",
          items: [
            "End-to-end runs assume a fresh database. `make e2e` recreates its own compose volume; a direct Playwright run on a kept stack needs `make down` first.",
            "Per-run port and database isolation for parallel local runs was descoped for time. Parallel local runs can collide.",
            "The Lighthouse performance rule for `/` is a warning, not an error. CI medians varied from 77 to 89 against a 0.85 budget, and I did not lower the budget. The other pages and all accessibility, best-practices and SEO rules are hard gates.",
            "`test_ably_real.py` needs the CI Ably key, so it runs only in CI.",
          ],
        },
        {
          t: "note",
          text: "The pre-push hook runs lint, hygiene and the backend unit tests, not the whole suite; the heavier layers run in CI. The billing-side live checks (budgets and the project list on the shared account) cannot run in CI, because the deployer must never hold a role on that account, so I run them by hand.",
        },
      ],
    },

    {
      id: "engineering-decisions",
      title: "Engineering decisions and extras",
      summary:
        "The headline choices with the alternative I turned down, then what I built beyond the brief and its status.",
      blocks: [
        {
          t: "p",
          text: "One row per headline decision with the alternative I rejected and what it costs me. Where the decisions page covers a choice, I link it. Statuses below are as of main.",
        },
        {
          t: "table",
          caption: "Headline decisions",
          head: ["Decision", "Rejected", "Why", "What it costs"],
          rows: [
            [
              "A partial unique index on `(doctor_id, starts_at) WHERE status = 'booked'` decides double booking ([double booking](/decisions#double-booking))",
              "`EXCLUDE USING gist`, SERIALIZABLE with retries, advisory locks, check-then-insert",
              "The smallest mechanism the engine enforces itself, so it holds across instances with no coordination.",
              "Correct only for fixed, aligned 30-minute slots. Variable lengths would need the `EXCLUDE` form.",
            ],
            [
              "Slots are computed from working hours",
              "A materialized slots table, an RRULE engine",
              "The working hours stay the only source of truth, so nothing drifts.",
              "No slot row to lock, so uniqueness lives on the appointment.",
            ],
            [
              "FastAPI is the single system of record ([one API](/decisions#one-api))",
              "Django REST Framework; FastAPI plus a Go service in the write path",
              "One runtime, typed end to end, and the OpenAPI document generates the client.",
              "Python cold starts. I set no latency target and measured none.",
            ],
            [
              "UTC `timestamptz`, the clinic zone as data, an injected clock ([time model](/decisions#time))",
              "The zone in environment config; naive local timestamps",
              "A second clinic needs no code change and tests pin time.",
              "An extra join to read the zone.",
            ],
            [
              "RFC 9457 problem details with a closed code catalogue ([REST contract](/decisions#rest-and-errors))",
              'FastAPI\'s default `{"detail": ...}`; a custom envelope',
              "Clients need a stable machine-readable `code`.",
              "A typed exception hierarchy to maintain, checked by a test against the written list of codes.",
            ],
            [
              "REST with OpenAPI 3.1 and a client generated from the contract",
              "tRPC, GraphQL, gRPC",
              "The brief says REST; tRPC needs a TypeScript server; GraphQL hides status codes.",
              "Type safety comes from codegen and a CI drift gate; the generator is 0.x and pinned.",
            ],
            [
              "Reschedule is one in-place `UPDATE` under `SELECT ... FOR UPDATE`",
              "Cancel and reinsert; an unlocked conditional update",
              "The appointment id stays stable and the old slot frees atomically.",
              "A swap can end with both requests rejected after one retry.",
            ],
            [
              "An idempotency key stored on the appointment row, with a request fingerprint",
              "No idempotency; a separate table of stored responses",
              "A lost response must not tell the real booker they lost the slot, and the replay needs no second store.",
              "A key is bound to one doctor and time; reuse with a different body is a 422.",
            ],
            [
              "Cloud Run IAM-only behind a Vercel proxy, in `us-east4` beside Neon in `aws-us-east-1` ([hosting and cost](/decisions#hosting-and-cost))",
              "Cloud Run in `africa-south1` or `europe-west3` with Neon in Frankfurt; Cloud SQL",
              "My $0 rule: egress to Kenya is billed from byte 0 outside North America, and each booking makes several database round trips.",
              "A longer hop for Kenyan users (estimated, not measured), and about $0.35 a month on the shared billing account.",
            ],
            [
              "Two database roles: an owner for migrations, an app role with no DDL rights ([ADR 0015](#adr-0015))",
              "One role for everything",
              "A compromised service cannot change the schema.",
              "Two secrets and two service accounts.",
            ],
            [
              "CircleCI, keyless OIDC to workload identity federation, promote by tag after a smoke test, roll back automatically ([rollback](#rollback))",
              "Cloud Build; a long-lived service-account key",
              "No long-lived GCP credential exists, and only a smoke-tested revision gets traffic.",
              "`VERCEL_TOKEN` is long-lived. A main pipeline takes roughly 10 to 12 minutes (an estimate).",
            ],
            [
              "Real Postgres in every test, a race harness that must fail without the index",
              "Mocked repositories on SQLite",
              "A mock cannot show a unique violation under contention.",
              "Slower suites and a compose database in CI.",
            ],
            [
              "The public API stays unauthenticated; patients and staff sign in with Google in the web apps ([thin web layer](/decisions#thin-web-layer))",
              "Mandatory auth on the API; optional bearer auth",
              "The brief is silent on authentication, and the endpoints and Swagger Try it out work without it.",
              "An IDOR on the public API, which I disclose.",
            ],
            [
              "Better Auth with stateless session cookies; roles looked up on every request",
              "Auth.js v5 beta; roles in the cookie; an email list in an environment variable",
              "Maintained, database-free sessions, and a revoke applies on the next request.",
              "One table lookup per request; a cookie cannot be revoked early.",
            ],
            [
              "Server actions call the API, with one reCAPTCHA check per action",
              "Browser calls through the proxy",
              "No browser code holds a credential and the human check runs on the server.",
              "The public `/api` proxy is not covered by the check.",
            ],
            [
              "Two apps in one pnpm workspace",
              "One app with an `/admin` route group; two repositories",
              "Separate auth surfaces and deploys without publishing shared packages.",
              "Two Vercel projects to keep in step.",
            ],
            [
              "Plain JSON logs with a `request_id` and no PII",
              "OpenTelemetry to Cloud Trace; Sentry",
              "The smallest thing that lets a problem body lead to a log line, within the free tier.",
              "No traces and no alerting beyond the cost checks.",
            ],
          ],
        },
        {
          t: "table",
          caption: "Beyond the brief",
          head: ["Item", "Why it earns its place", "Status"],
          rows: [
            [
              "Race-proof tests with a naive control",
              "A concurrency test that cannot fail proves nothing.",
              "Shipped",
            ],
            [
              "Idempotency keys",
              "A retried POST must not look like a lost race.",
              "Shipped",
            ],
            [
              "Immutable releases, tagged no-traffic deploys, automatic rollback ([rollback](#rollback))",
              "Auto-deploy on merge without a way back is what I would not ship at work.",
              "Built. Not yet seen moving production traffic back.",
            ],
            [
              "Security gates in CI (gitleaks, semgrep, pip-audit, Trivy, ZAP)",
              "Each tool covers one concern.",
              "Shipped",
            ],
            [
              "Cost guards (`cost_check.sh`, static and live, with a self-test)",
              "My own $0 rule. Drift would otherwise show up as an invoice.",
              "Shipped",
            ],
            [
              "Generated, validated API client",
              "One contract for the server and both apps.",
              "Shipped",
            ],
            [
              "Patient booking app with Google sign-in and reCAPTCHA per action",
              "The brief's patient flow.",
              "Shipped",
            ],
            [
              "Admin dashboard with owner, admin and viewer roles and a lineage view",
              "A clinic needs to see and fix appointments.",
              "Shipped",
            ],
            [
              "Shell-only PWA and 15 second slot polling ([polling then push](/decisions#polling-then-push))",
              "A stale slot list is the UX failure of the race the brief names.",
              "Shipped",
            ],
            [
              "Booking emails and a daily reminder (Resend)",
              "A patient needs a record of the booking.",
              "Shipped. Booking and cancellation emails verified live on 2026-10-18; the daily reminder's first send was unconfirmed then.",
            ],
            [
              "Live slot events through an outbox relay and Ably",
              "Shows a taken slot without waiting for the next poll.",
              "Shipped, with polling as the safety net",
            ],
            [
              "Production ZAP baseline, Lighthouse budgets, a kill switch",
              "Checks the live site, not only the compose stack.",
              "Shipped. The Lighthouse `/` performance rule is a warning.",
            ],
            [
              "Self-hosted Swagger UI, ReDoc and fonts",
              "The reviewer's first click must not depend on a CDN.",
              "Shipped",
            ],
            [
              "Per-run port and database isolation for local end to end",
              "Parallel local runs would not collide.",
              "Descoped. `make e2e` already starts fresh.",
            ],
            [
              "Go gateway and staff live feed ([the Go decision](/decisions#go), [the Go card](#go-gateway))",
              "Staff events carry patient names, which should stay inside Google Cloud.",
              "Shipped and deployed. The cost measurement is pending.",
            ],
          ],
        },
      ],
    },

    {
      id: "ai-usage",
      title: "AI usage",
      summary:
        "Which decisions were mine, what AI sessions did, which models were used where, and what is not recorded.",
      blocks: [
        {
          t: "p",
          text: "A factual list. Each item comes from a record I kept: a dated note, a pull request comment or a decision entry. Where the repository holds no record, I say so at the end.",
        },
        {
          t: "p",
          text: "**What I decided.** Product, cost and security calls that were mine:",
        },
        {
          t: "ul",
          items: [
            "Total cost is $0, provable from official free-tier pages (2026-10-16). The recorded outcome is not $0 on the shared billing account: Artifact Registry and Secret Manager are over their free tiers there, and I accepted and disclosed the few cents.",
            "The hosting split: Vercel front end, Cloud Run in `us-east4` behind IAM, Neon in `aws-us-east-1` (2026-10-16).",
            "Decisions are written and locked before implementation starts. Implementation then goes to cheaper models (2026-10-16).",
            "No mocks of our own code; only third parties may be stood in, and labelled (2026-10-17).",
            "Frontend schemas are generated from the contract, not hand-written (2026-10-17).",
            "A full CI-equivalent suite green locally before every push, one push per fix round (2026-10-17).",
            "Two apps in one workspace, with their public hostnames; the booking flow with one human check per action; staff roles by email (2026-10-17).",
            "The public REST API stays unauthenticated (2026-10-17).",
            "Ably's free package for patient slot events instead of server-sent events from our own service (2026-10-18), then the staff live feed back on the Go gateway because staff events carry names (2026-10-19).",
            "Drop the Docker Hub context and pull CI images through `mirror.gcr.io` (2026-10-16).",
            "The AI reflection in the README is written by me only.",
          ],
        },
        {
          t: "p",
          text: "**What AI sessions did.**",
        },
        {
          t: "ul",
          items: [
            "**Planning and decisions.** A planning session drafted the decisions and the delivery plan. Where a draft was recorded only as engineering, the AI proposed the text and I accepted it. The ones recorded as decided by me are my decisions.",
            "**Implementation.** Each work item ran as its own AI coding session in a separate git worktree and branch cut from `main`, with its own compose project and ports, and opened its own pull request. Those sessions did not merge.",
            "**Review.** A separate AI session read each diff and ran its own checks against a real stack. Its findings and the fixes are in the pull request threads.",
            "**Merging.** A different session merged pull requests, never the one that built them, and only after every check was green and the base branch was `main`.",
            "**Assets and data.** The doctor portraits are AI-generated (Z-Image-Turbo), and the demo patients' names are AI-generated and fictional.",
          ],
        },
        {
          t: "table",
          caption:
            "Models by task, from my routing rules and the session records",
          head: ["Task", "Model"],
          rows: [
            ["Planning, decisions, architecture", "The largest tier (Opus)"],
            ["Implementation", "Sonnet at medium effort"],
            ["Review", "Sonnet at high effort"],
            ["Mechanical bulk edits (config, autofix)", "Haiku"],
          ],
        },
        {
          t: "p",
          text: "There was no multi-agent fan-out inside a work item, and review reports were bounded to about 15 lines.",
        },
        {
          t: "p",
          text: "**What AI did not do.** No AI session handled a secret. I created the reCAPTCHA keys and the Google OAuth client myself, and the Vercel and CircleCI tokens went straight into their contexts without being printed. Cloud commands that create or change a resource (`gcloud`, `neonctl`, `vercel`, `circleci`) waited for my approval, until on 2026-10-16 I authorised the bootstrap steps 1 to 9 within the $0 guards.",
        },
        {
          t: "p",
          text: "**Stop rules.** Halt if the shared billing account stops being $0 on compute or anything billable appears. Autopilot stops at 68 percent of weekly usage; on 2026-10-18 it paused at 71 percent and I told it to resume with every gate kept. No cloud mutation from a documentation or test session, and never touch my other GCP projects. Commits are terse with no tooling references and no trailers, and hooks enforce lint, message form and `gitleaks`.",
        },
        {
          t: "p",
          text: "**Human checkpoints.**",
        },
        {
          t: "ol",
          items: [
            "Decisions reviewed and locked before the build started.",
            "Each cloud step approved, then the runbook authorised within the $0 guards.",
            "The billing account choice and the acceptance of the shared-account cost.",
            "Credentials created by me: reCAPTCHA keys, the Google OAuth client, tokens, DNS records at the registrar.",
            "Every pull request reviewed by a separate session before merge.",
            "A read-through of the finished repository and the live site before submission, against a written checklist that is not in the repository.",
          ],
        },
        {
          t: "note",
          text: "Not recorded: the share of code an AI session wrote against what I wrote by hand, per package, because the repository has no measure. The raw prompt log is kept out of git on purpose.",
        },
      ],
    },
  ],
};
