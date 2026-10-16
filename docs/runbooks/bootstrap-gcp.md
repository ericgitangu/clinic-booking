# Runbook: GCP + Vercel bootstrap

One-time setup by the engineer. Nothing in CI creates infrastructure; CI only deploys.
All `gcloud` calls pass `--account developer.ericgitangu@gmail.com` because the active
account on this machine differs.

## Order of operations

1. **State bucket + Cloud Run shell** — `PROJECT=sil-clinic-booking GCLOUD_ACCOUNT=developer.ericgitangu@gmail.com BILLING_ACCOUNT=<id> bash infra/bootstrap.sh` (steps 1-2).
2. **Terraform apply** — identities, APIs, Artifact Registry, secrets (containers only), WIF
   pools, budget, monitoring, logging:
   ```bash
   cd infra/terraform
   terraform init -backend-config=bucket=clinic-tfstate-$PROJECT
   cp terraform.tfvars.example terraform.tfvars   # fill in ids (no secrets)
   terraform plan -out tfplan
   # Cost gate (global rule 8): STOP if anything matches.
   terraform show -no-color tfplan | rg -n 'min_instance|google_compute_router_nat|google_compute_global_address|google_compute_forwarding_rule|google_redis|google_sql|google_compute_address|google_vpc_access_connector|google_compute_instance|google_container_cluster|google_compute_region_network_endpoint_group|google_compute_backend_service|REMOTE_REPOSITORY|user_managed|google_cloud_scheduler|google_monitoring_uptime_check|containerscanning|ondemandscanning|cloudbuild|europe-west|STANDARD_IA|dual-region|multi-region' && echo STOP || terraform apply tfplan
   ```
3. **Invoker bindings** — bootstrap.sh step 3 (now that the SAs exist): grant `run.invoker`
   on `clinic-api` to `clinic-web@` and `clinic-smoke@` only. Never `allUsers`.
4. **$3 gross Cloud Run spend cap** — console → Billing → Budgets, scope project + Cloud Run
   service (`152E-C115-5142`), $3 **gross**, action = cap/pause. Record the budget id here:
   `BUDGET_ID=<fill in>`. Screenshot the spend-cap action (C11).
5. **Neon** — follow `docs/runbooks/neon.md`; add the two secret versions.
6. **Vercel (Part C0)** — `vercel project add clinic-web --scope <team>`; confirm OIDC issuer
   mode Team; leave Root Directory empty; `cd web && vercel link --yes --project clinic-web
   --scope <team>`; read `orgId`/`projectId` from `web/.vercel/project.json` and add them plus
   `VERCEL_TOKEN` to the CircleCI `vercel-prod` context; `vercel env add <NAME> production
   --cwd web` for each name in §7 "web proxy config".

## Negative tests (record the log/probe URLs here)

- **WIF deny:** branch `test/wif-deny`, job on context `oidc-probe` attempting the OIDC
  exchange → permission denied. Log URL: `<fill in>`.
- **Context deny:** same branch, job attaching `gcp-deploy` → unauthorized-context failure.
  Log URL: `<fill in>`.
- **Vercel exchange deny:** throwaway project `clinic-wif-probe`, POST its dev OIDC token to
  STS → 400/403 attribute-condition error. Recorded `sub`: `<fill in>`. Delete the probe.

## Manual cost checks (screenshots)

- C11 spend-cap action; C14 one project on the billing account; C15 Vercel Hobby + no card;
  C16 CircleCI month-to-date credits + no card; C17 Billing → Reports after 48h (gross and
  Free-Tier savings per SKU); CircleCI Plan → Usage Controls at minimum retention.
