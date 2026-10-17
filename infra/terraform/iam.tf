# Service accounts. The Cloud Run service itself is NOT managed by Terraform (bootstrap.sh
# creates it); run.invoker bindings on the service are added by bootstrap.sh via gcloud, so
# CI never needs setIamPolicy and never passes --allow-unauthenticated.
resource "google_service_account" "deployer" {
  account_id   = "circleci-deployer"
  display_name = "CircleCI deployer (WIF)"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "api_runtime" {
  account_id   = "clinic-api-runtime"
  display_name = "clinic-api runtime"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "migrate" {
  account_id   = "clinic-migrate"
  display_name = "clinic-migrate job"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "web" {
  account_id   = "clinic-web"
  display_name = "Vercel web proxy identity"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "smoke" {
  account_id   = "clinic-smoke"
  display_name = "Smoke-test invoker"
  depends_on   = [google_project_service.enabled]
}

# --- Deployer: deploy + push + act-as the runtime/migrate SAs ---
resource "google_project_iam_member" "deployer_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_ar_writer" {
  location   = var.region
  repository = google_artifact_registry_repository.clinic.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  service_account_id = google_service_account.api_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_migrate" {
  service_account_id = google_service_account.migrate.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# --- Deployer: read-only metadata for cost-check; mint smoke tokens ---
resource "google_project_iam_member" "deployer_secret_viewer" {
  project = var.project_id
  role    = "roles/secretmanager.viewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_serviceusage_viewer" {
  project = var.project_id
  role    = "roles/serviceusage.serviceUsageViewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# cost-check (CI) reads the log sinks and the _Default bucket retention (check C18).
resource "google_project_iam_member" "deployer_logging_viewer" {
  project = var.project_id
  role    = "roles/logging.viewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# roles/artifactregistry.writer cannot delete versions or tags, so the release prune would be
# denied. This role adds exactly that on the one repository, without the broader repoAdmin
# (which also covers packages, rules and files).
resource "google_project_iam_custom_role" "image_pruner" {
  role_id     = "clinicImagePruner"
  title       = "Clinic image pruner"
  description = "Delete image versions and tags in the clinic repository during release pruning."
  permissions = [
    "artifactregistry.versions.delete",
    "artifactregistry.tags.delete",
    "artifactregistry.repositories.deleteArtifacts",
  ]
  depends_on = [google_project_service.enabled]
}

resource "google_artifact_registry_repository_iam_member" "deployer_ar_pruner" {
  location   = var.region
  repository = google_artifact_registry_repository.clinic.repository_id
  role       = google_project_iam_custom_role.image_pruner.id
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_mint_smoke" {
  service_account_id = google_service_account.smoke.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# --- Runtime/migrate: least-privilege secret access, one secret each ---
resource "google_secret_manager_secret_iam_member" "runtime_app_secret" {
  secret_id = google_secret_manager_secret.database_url_app.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "migrate_secret" {
  secret_id = google_secret_manager_secret.database_url_migrate.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrate.email}"
}

# ---- read access for the CI cost check (scripts/cost_check.sh --live) ------------------------
# Each permission below is read-only metadata and exists for exactly one check. The billing
# checks (budgets, projects on the shared billing account) are NOT covered: they need a billing
# role on a shared account, which the deployer must never hold, so they run locally.

# C12 reads the egress alert policy; C20 reads the project IAM policy to confirm the default
# Compute service account has no roles/editor. getIamPolicy shows who holds which role (the
# bindings are already documented in this public repo); it cannot change anything.
resource "google_project_iam_custom_role" "cost_check_reader" {
  role_id     = "clinicCostCheckReader"
  title       = "Clinic cost check reader"
  description = "Read the alert policies and the project IAM policy for the CI cost check."
  permissions = [
    "monitoring.alertPolicies.get",
    "monitoring.alertPolicies.list",
    "resourcemanager.projects.getIamPolicy",
  ]
}

resource "google_project_iam_member" "deployer_cost_check_reader" {
  project = var.project_id
  role    = google_project_iam_custom_role.cost_check_reader.id
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# C9 reads the state bucket's location, class and soft-delete setting. Granted on that one
# bucket, with storage.buckets.get only: no object listing and no object reads.
resource "google_project_iam_custom_role" "bucket_meta_reader" {
  role_id     = "clinicBucketMetaReader"
  title       = "Clinic bucket metadata reader"
  description = "Read a bucket's configuration (not its objects)."
  permissions = ["storage.buckets.get"]
}

resource "google_storage_bucket_iam_member" "deployer_state_bucket_meta" {
  bucket = "clinic-tfstate-${var.project_id}"
  role   = google_project_iam_custom_role.bucket_meta_reader.id
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# ---- reCAPTCHA assessments from the web app's server side ---------------------------------------
# The BFF verifies score-based reCAPTCHA tokens with projects.assessments.create. It has no API
# key and no secret: Vercel's OIDC identity (the same federated principal that mints the Cloud Run
# ID token) may mint short-lived tokens for this one account, and the account holds only the
# reCAPTCHA Enterprise Agent role.
resource "google_service_account" "recaptcha" {
  account_id   = "clinic-recaptcha"
  display_name = "reCAPTCHA assessments for the web app"
  depends_on   = [google_project_service.enabled]
}

resource "google_project_iam_member" "recaptcha_agent" {
  project = var.project_id
  role    = "roles/recaptchaenterprise.agent"
  member  = "serviceAccount:${google_service_account.recaptcha.email}"
}

resource "google_service_account_iam_member" "vercel_impersonate_recaptcha" {
  service_account_id = google_service_account.recaptcha.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.vercel_principal
}
