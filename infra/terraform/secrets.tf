# Secret CONTAINERS only; versions are added out-of-band by the Neon runbook
# (printf %s "$URL" | gcloud secrets versions add ...). No secret values in Terraform/state.
resource "google_secret_manager_secret" "database_url_app" {
  secret_id = "clinic-database-url-app"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret" "database_url_migrate" {
  secret_id = "clinic-database-url-migrate"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

# The signing key behind the app-to-API assertion. The container already exists and holds
# its one version, added out-of-band; it is adopted here, not recreated, and no value is in state.
# Remove the import block after the first apply that has adopted it.
resource "google_secret_manager_secret" "internal_signing_key" {
  secret_id = "clinic-internal-signing-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

import {
  to = google_secret_manager_secret.internal_signing_key
  id = "projects/sil-clinic-booking/secrets/clinic-internal-signing-key"
}

# The smoke test's own signing key. It signs one call, /internal/smoke/patients, which creates a
# patient the admin views ignore, and nothing else, so a leak cannot forge an admin or patient
# assertion. The container was first created by gcloud, outside Terraform, and is adopted here
# by the import blocks below; the value is added by hand, never by Terraform:
#   openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add clinic-smoke-signing-key \
#     --project sil-clinic-booking --data-file=-
# Remove the import blocks after the first apply that has adopted them.
resource "google_secret_manager_secret" "smoke_signing_key" {
  secret_id = "clinic-smoke-signing-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

import {
  to = google_secret_manager_secret.smoke_signing_key
  id = "projects/sil-clinic-booking/secrets/clinic-smoke-signing-key"
}

import {
  to = google_secret_manager_secret_iam_member.runtime_smoke_key
  id = "projects/sil-clinic-booking/secrets/clinic-smoke-signing-key roles/secretmanager.secretAccessor serviceAccount:clinic-api-runtime@sil-clinic-booking.iam.gserviceaccount.com"
}

import {
  to = google_secret_manager_secret_iam_member.deployer_smoke_key
  id = "projects/sil-clinic-booking/secrets/clinic-smoke-signing-key roles/secretmanager.secretAccessor serviceAccount:circleci-deployer@sil-clinic-booking.iam.gserviceaccount.com"
}
