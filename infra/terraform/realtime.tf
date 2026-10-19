# The live-feed gateway's identity and secrets. Nothing here creates a Cloud Run service or an
# invoker binding: the service is deployed by the ship-realtime job exactly like clinic-api (a
# `gcloud run deploy` line that scripts/cost_check.sh pins), because infra/plan_gate.sh and
# cost_check ban every Cloud Run resource in Terraform so that no plan can loosen a cost setting.
# The run.invoker bindings (clinic-admin and clinic-smoke only, never the public proxy) are made
# once by `bash infra/bootstrap.sh invoker`; the CI deployer has no setIamPolicy by design, and the
# job fails with that exact command if the bindings are missing.
#
# What the pipeline deploys (see ship-realtime in .circleci/config.yml):
#   --min-instances 0 --max-instances 2 --concurrency 1 --cpu 0.25 --memory 256Mi
#   --execution-environment gen1 --cpu-boost --timeout 900 --no-allow-unauthenticated
# It scales from zero to at most two instances on demand and back to zero when idle. CPU
# throttling stays on (request-based billing: an open stream is an active request, an idle
# instance is not billed). Concurrency 1 is not a choice: Cloud Run requires it below 1 vCPU
# (docs.cloud.google.com/run/docs/configuring/services/cpu), and 1 vCPU would cost four times as
# much per connected hour. If Cloud Run rejects 0.25 vCPU with 256 MiB, the fallback is --cpu 0.5,
# which cost_check accepts; record the real error text in docs/adr/0021.

resource "google_service_account" "realtime_runtime" {
  account_id   = "clinic-realtime-runtime"
  display_name = "clinic-realtime runtime"
  depends_on   = [google_project_service.enabled]
}

# A container only. The version (the URL of the read-only clinic_realtime login on the direct Neon
# endpoint) is added out of band: docs/runbooks/neon.md, "Optional realtime feature".
resource "google_secret_manager_secret" "database_url_realtime" {
  secret_id = "clinic-database-url-realtime"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# The runtime reads three secrets and nothing else: its own database URL, the key the admin app
# signs the staff assertion with, and the smoke key (so the release smoke can open one stream).
resource "google_secret_manager_secret_iam_member" "realtime_database_url" {
  secret_id = google_secret_manager_secret.database_url_realtime.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.realtime_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "realtime_signing_key" {
  secret_id = google_secret_manager_secret.internal_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.realtime_runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "realtime_smoke_key" {
  secret_id = google_secret_manager_secret.smoke_signing_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.realtime_runtime.email}"
}

# ship-realtime deploys with --service-account, which needs act-as on exactly this account.
resource "google_service_account_iam_member" "deployer_act_as_realtime" {
  service_account_id = google_service_account.realtime_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
